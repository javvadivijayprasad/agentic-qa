import { Ledger, sha256 } from "../ledger/ledger.js";
import { renderMarkdown } from "../ledger/replay.js";
import type { Gate, GateVerdict } from "../governance/policy.js";
import type { AgentConfig, RunStatus, Skill, VerifyPayload } from "../types.js";
import { EXIT_CODES } from "../types.js";
import type { Approver } from "./approval.js";
import { summarizeCalls } from "./approval.js";
import type { Clock } from "./clock.js";
import { systemClock } from "./clock.js";
import type { ContextBuilder } from "./context.js";
import { OrderedContextBuilder, compactResult } from "./context.js";
import type { HistoryItem, ModelClient, ProposedCall } from "./model.js";
import type { ToolClient, ToolDescriptor } from "./tools.js";
import { splitQualified } from "./tools.js";

export interface LoopDeps {
  /** The natural-language request from the engineer. */
  requestText: string;
  model: ModelClient;
  tools: ToolClient;
  gate: Gate;
  approver: Approver;
  skill: Skill;
  ledger: Ledger;
  config: AgentConfig;
  workspaceDir: string;
  clock?: Clock;
  context?: ContextBuilder;
  /** Deterministic approval ids for fixtures/tests; default is apr-0001, apr-0002, … */
  approvalIdFor?: (n: number) => string;
}

export interface LoopResult {
  status: RunStatus;
  exitCode: number;
  summary: string;
  runId: string;
  events: number;
}

/**
 * The plan → act → observe → verify cycle (design §4). Owns the stop rules and
 * the ledger; owns no QA knowledge. The model decides the next action only;
 * the gate decides whether it may happen; the verifier decides "done".
 */
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const clock = deps.clock ?? systemClock;
  const ctx =
    deps.context ??
    new OrderedContextBuilder(
      deps.skill.sourceTools ? { sourceTools: deps.skill.sourceTools } : {},
    );
  const { ledger, model, tools, gate, approver, skill, config } = deps;
  const approvalIdFor = deps.approvalIdFor ?? ((n) => `apr-${String(n).padStart(4, "0")}`);

  const history: HistoryItem[] = [];
  let steps = 0;
  let tokens = 0;
  let approvals = 0;
  let gaps: string[] | undefined;
  let retriedAfterGaps = false;

  const finish = async (status: RunStatus, summary: string): Promise<LoopResult> => {
    ledger.append("end", { status, summary, exitCode: EXIT_CODES[status] }, clock.now());
    ledger.writeSummary(renderMarkdown(ledger.read()));
    return {
      status,
      exitCode: EXIT_CODES[status],
      summary,
      runId: ledger.runId,
      events: ledger.read().length,
    };
  };

  try {
    // ---- request -----------------------------------------------------------
    const text = deps.requestText;
    ledger.append(
      "request",
      { text, skill: skill.name, configHash: `sha256:${sha256(JSON.stringify(config))}` },
      clock.now(),
    );

    // Tools visible to this skill only.
    const all = await tools.listTools();
    const allowed = new Set(skill.allowedTools);
    const visible: ToolDescriptor[] = all.filter((t) => allowed.has(`${t.server}.${t.name}`));
    const byName = new Map<string, ToolDescriptor>(
      visible.map((t) => [`${t.server}.${t.name}`, t]),
    );

    // ---- plan --------------------------------------------------------------
    const planInput = ctx.build({
      request: text,
      skillInstructions: skill.instructions,
      tools: visible,
      history,
    }).input;
    const plan = await model.plan(planInput);
    tokens += plan.usage.inputTokens + plan.usage.outputTokens;
    ledger.append("plan", { steps: plan.steps }, clock.now());

    // ---- cycles ------------------------------------------------------------
    for (;;) {
      if (steps >= config.budgets.steps)
        return finish(
          "budget",
          `step budget of ${config.budgets.steps} exhausted after ${steps} steps`,
        );
      if (tokens >= config.budgets.tokens)
        return finish(
          "budget",
          `token budget of ${config.budgets.tokens} exhausted (${tokens} used)`,
        );
      steps++;

      const built = ctx.build({
        request: text,
        skillInstructions: skill.instructions,
        tools: visible,
        history,
        ...(gaps ? { gaps } : {}),
      });
      ledger.append("context", built.event, clock.now());

      const decision = await model.decide(built.input);
      tokens += decision.usage.inputTokens + decision.usage.outputTokens;

      // Goal reached → verify.
      if (decision.calls.length === 0) {
        ledger.append(
          "inference",
          {
            model: model.model,
            promptVersion: model.promptVersion,
            toolName: null,
            args: null,
            usage: decision.usage,
          },
          clock.now(),
        );
        const verdict: VerifyPayload = await skill.verifier.verify({
          events: ledger.read(),
          workspaceDir: deps.workspaceDir,
        });
        ledger.append("verify", verdict, clock.now());
        if (verdict.done) return finish("done", decision.note ?? "goal verified");
        if (retriedAfterGaps)
          return finish(
            "blocked",
            `verifier gaps remain after retry: ${verdict.gaps.map((g) => g.code).join(", ")}`,
          );
        retriedAfterGaps = true;
        gaps = verdict.gaps.map((g) => `${g.code}: ${g.message}`);
        continue;
      }
      gaps = undefined;

      // One inference event per proposed call (parallel tool use), then gate each.
      const verdicts: Array<{ call: ProposedCall; verdict: GateVerdict }> = [];
      for (const call of decision.calls) {
        ledger.append(
          "inference",
          {
            model: model.model,
            promptVersion: model.promptVersion,
            toolName: call.toolName,
            args: call.args,
            usage: decision.usage,
          },
          clock.now(),
        );
        verdicts.push({ call, verdict: gate.judge(call, byName.get(call.toolName)) });
      }

      // Batch every "ask" in this cycle into ONE approval (design §7).
      const asks = verdicts.filter((v) => v.verdict.decision === "ask");
      let approvalId: string | undefined;
      let approved = true;
      if (asks.length > 0) approvalId = approvalIdFor(++approvals);

      for (const { verdict } of verdicts) {
        const payload = {
          toolName: verdict.toolName,
          class: verdict.class,
          decision: verdict.decision,
          reason: verdict.reason,
        };
        ledger.append(
          "policy",
          verdict.decision === "ask" && approvalId ? { ...payload, approvalId } : payload,
          clock.now(),
        );
      }

      if (asks.length > 0 && approvalId) {
        const calls = asks.map((a) => a.call);
        const summary = summarizeCalls(calls);
        ledger.append("approval_requested", { approvalId, summary, calls }, clock.now());
        const result = await approver.ask({ approvalId, summary, calls });
        ledger.append(
          "approval_resolved",
          { approvalId, decision: result.decision, by: result.by, at: result.at },
          clock.now(),
        );
        approved = result.decision === "approved";
      }

      // Execute in order; refused/denied calls are fed back to the model as history.
      for (const { call, verdict } of verdicts) {
        if (verdict.decision === "refuse") {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: `refused by governance gate: ${verdict.reason}`,
            ledgerRef: `ledger://${ledger.runId}/policy`,
            gate: { decision: "refuse", reason: verdict.reason },
          });
          continue;
        }
        if (verdict.decision === "ask" && !approved) {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: "approval denied by reviewer",
            ledgerRef: `ledger://${ledger.runId}/approval/${approvalId}`,
            gate: { decision: "denied", reason: "approval denied" },
          });
          continue;
        }
        const target = splitQualified(call.toolName)!; // gate refused unknown tools already
        const startedAt = clock.now();
        const callEvent = ledger.append(
          "call",
          { server: target.server, toolName: target.name, args: call.args, startedAt },
          startedAt,
        );
        let ok = false;
        let result: unknown;
        let artefacts: string[] = [];
        try {
          const r = await tools.call(target.server, target.name, call.args);
          ok = r.ok;
          result = r.result;
          artefacts = r.artefacts;
        } catch (e) {
          ok = false;
          result = { message: (e as Error).message };
        }
        const endedAt = clock.now();
        const obs = ledger.append(
          "observation",
          {
            eventIdOfCall: callEvent.eventId,
            ok,
            result,
            artefacts,
            durationMs: endedAt - startedAt,
          },
          endedAt,
        );
        history.push({
          toolName: call.toolName,
          ok,
          summary: compactResult(result),
          ledgerRef: `ledger://${ledger.runId}/${obs.eventId}`,
        });
      }

      // If a denied approval blocked every call this cycle and nothing else can happen, stop.
      if (asks.length > 0 && !approved && asks.length === verdicts.length) {
        return finish("blocked", `approval ${approvalId} denied by reviewer`);
      }
    }
  } catch (e) {
    return finish("error", (e as Error).message);
  }
}
