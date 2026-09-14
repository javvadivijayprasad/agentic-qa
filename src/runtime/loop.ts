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
import { OrderedContextBuilder, compactResult, SOURCE_CHARS, STEP_CHARS } from "./context.js";
import { authorizationFailure, deniedOperationReason, operationKey } from "./denials.js";
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

/** Cycles of pure repetition tolerated before the run is ended as blocked. */
export const MAX_STALE_CYCLES = 3;

/** Key-order-independent signature of a call's arguments. */
function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
  );
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
  /**
   * Signatures of calls already executed, and how many cycles have produced
   * nothing new. A model that cannot make progress tends to repeat itself
   * rather than stop, and without this the run simply burns its budget doing
   * the same read over and over (observed: the same two files read 29 times).
   */
  const executed = new Set<string>();
  let staleCycles = 0;
  /**
   * Operations the environment has refused on authorization grounds, and the
   * sentence it refused them with. These are closed for the rest of the run:
   * the gate would allow them, the reviewer might approve them, and they would
   * fail again identically (see `denials.ts`).
   */
  const deniedOps = new Map<string, string>();
  /** The model's own words, cycle by cycle — fed back so it can follow a plan. */
  const notes: string[] = [];

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
    // Primary sources are what the job is ABOUT — the story, a file, a parsed
    // feature — so they get a much larger window than a step result.
    const sourceTools = new Set(skill.sourceTools ?? []);

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
        ...(notes.length > 0 ? { notes } : {}),
      });
      ledger.append("context", built.event, clock.now());

      const decision = await model.decide(built.input);
      tokens += decision.usage.inputTokens + decision.usage.outputTokens;
      if (decision.note) notes.push(decision.note);

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
            ...(decision.note ? { note: decision.note } : {}),
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
      // Server-configured defaults are merged FIRST, so the gate judges — and
      // the ledger records — the arguments that will actually be sent.
      const verdicts: Array<{ call: ProposedCall; verdict: GateVerdict }> = [];
      for (const proposed of decision.calls) {
        const tool = byName.get(proposed.toolName);
        const call: ProposedCall = tool?.defaultArgs
          ? { toolName: proposed.toolName, args: { ...tool.defaultArgs, ...proposed.args } }
          : proposed;
        ledger.append(
          "inference",
          {
            model: model.model,
            promptVersion: model.promptVersion,
            toolName: call.toolName,
            args: call.args,
            usage: decision.usage,
            // On the first call of the cycle only: the reasoning belongs to the
            // decision, not to each call it produced.
            ...(decision.note && verdicts.length === 0 ? { note: decision.note } : {}),
          },
          clock.now(),
        );
        // An operation the environment has already refused is refused here,
        // BEFORE the approval batch is assembled — so the reviewer is never
        // asked to approve a call that is known to be dead on arrival.
        const gateVerdict = gate.judge(call, tool);
        const quoted = deniedOps.get(operationKey(call.toolName, call.args));
        verdicts.push({
          call,
          verdict: quoted
            ? {
                ...gateVerdict,
                decision: "refuse",
                reason: deniedOperationReason(operationKey(call.toolName, call.args), quoted),
              }
            : gateVerdict,
        });
      }

      // Stop rule: a cycle whose calls were ALL made before has advanced
      // nothing. Feed that back once, then end the run rather than spending the
      // remaining budget on repetition.
      const signatures = verdicts.map((v) => `${v.call.toolName} ${stableArgs(v.call.args)}`);
      const allRepeats = signatures.length > 0 && signatures.every((sig) => executed.has(sig));
      if (allRepeats) {
        staleCycles++;
        if (staleCycles >= MAX_STALE_CYCLES) {
          return finish(
            "blocked",
            `no progress: the same call(s) were proposed ${staleCycles} cycles running (${signatures[0]}). Their results are already in the ledger.`,
          );
        }
        for (const { call } of verdicts) {
          history.push({
            toolName: call.toolName,
            ok: false,
            summary: "",
            ledgerRef: `e${ledger.read().length}`,
            gate: {
              decision: "refuse",
              reason:
                "you have already made this exact call and its result is in your context; repeating it cannot change anything — do something different or stop and explain what is blocking you",
            },
          });
        }
        continue;
      }
      staleCycles = 0;
      for (const sig of signatures) executed.add(sig);

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
        // A failure the environment will repeat for any arguments closes the
        // operation for the rest of the run, and the model is told so in the
        // same breath as the failure — otherwise it does the reasonable thing
        // and tries again with different arguments (observed: four times).
        const refusedForever = ok ? undefined : authorizationFailure(result);
        const opKey = operationKey(call.toolName, call.args);
        if (refusedForever) deniedOps.set(opKey, refusedForever);
        history.push({
          toolName: call.toolName,
          ok,
          summary: refusedForever
            ? deniedOperationReason(opKey, refusedForever)
            : compactResult(result, sourceTools.has(call.toolName) ? SOURCE_CHARS : STEP_CHARS),
          ledgerRef: `ledger://${ledger.runId}/${obs.eventId}`,
        });

        // A call that CHANGED something invalidates the repeat memo: running
        // the same suite again after editing a spec is the same call with a
        // different meaning, and refusing it strands the agent — observed, with
        // the model rewriting the file thirteen times trying to get a re-run
        // past the rule.
        const changedTheWorld =
          artefacts.length > 0 || (byName.get(call.toolName)?.policyClass ?? "read") !== "read";
        if (ok && changedTheWorld) executed.clear();
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
