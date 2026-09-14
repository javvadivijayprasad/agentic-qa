import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import type { AnyRunEvent } from "../../types.js";
import {
  artefacts,
  asRecord,
  completedCalls,
  successful,
  testedByIds,
} from "../../verify/evidence.js";
import { createdCaseIds } from "../../verify/story-to-tests.js";

export interface SummaryOptions {
  /** The story the run is scoped to, when there is one. */
  workItem?: string;
  /**
   * Things this environment could not do, stated up front — e.g. no Test Plans
   * access level. These are facts about the account rather than results, so
   * they are supplied rather than read out of the ledger.
   */
  limitations?: string[];
}

/** Just enough of the Ledger to read a run back; keeps this adapter testable. */
export interface LedgerView {
  readonly runId: string;
  read(): AnyRunEvent[];
}

/**
 * In-process `aqa` adapter: the run's own report, composed from the LEDGER.
 *
 * Everywhere else in this runtime the model proposes and code decides. The one
 * place that was not true was the comment posted back to the story: the model
 * wrote prose about its own work — "5 passed", "no duplicates were introduced"
 * — and nothing checked it. It happened to be accurate. It was still a claim
 * standing where evidence belongs, and it could disagree with `aqa replay`
 * without anyone noticing.
 *
 * So the numbers are counted here, from what was observed to happen, and the
 * agent's job is reduced to posting the text verbatim. It may add its own
 * commentary around it; it cannot restate the figures, because it no longer
 * has to.
 */
export class SummaryTools implements ToolClient {
  readonly server = "aqa";

  constructor(
    private readonly ledger: LedgerView,
    private readonly opts: SummaryOptions = {},
  ) {}

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "run_summary",
        description:
          "Compose this run's report from the ledger: the suite result, the test cases created " +
          "or already linked, the spec files written, and any checks the environment prevented. " +
          "Returns { text } — post that text verbatim; do not restate the figures yourself, " +
          "because these are counted from what actually happened rather than from memory. " +
          "Reads the ledger only; writes nothing.",
        inputSchema: { type: "object", properties: {}, required: [] },
        policyClass: "read",
      },
    ];
  }

  async call(server: string, name: string, _args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "run_summary")
      return { ok: false, result: { message: `unknown aqa tool: ${name}` }, artefacts: [] };

    const events = this.ledger.read();
    const calls = completedCalls(events);

    const runs = successful(calls, "pw.run_tests");
    const suite = asRecord(runs[runs.length - 1]?.result);

    const created = [...createdCaseIds(events)].sort((a, b) => a - b);
    const story = this.opts.workItem;
    const reads = story
      ? successful(calls, "ado.wit_work_item", "get").filter(
          (c) => String(c.args["id"] ?? "") === story,
        )
      : [];
    const preexisting = [...new Set(reads.flatMap((r) => testedByIds(r.result)))]
      .filter((id) => !created.includes(id))
      .sort((a, b) => a - b);

    const specs = artefacts(calls).filter((p) => /\.(spec|test)\.[cm]?[jt]sx?$/i.test(p));

    return {
      ok: true,
      result: {
        text: render({
          runId: this.ledger.runId,
          ...(story !== undefined ? { workItem: story } : {}),
          ...(suite ? { suite } : {}),
          created,
          preexisting,
          specs,
          limitations: this.opts.limitations ?? [],
        }),
        runId: this.ledger.runId,
        suite: suite ?? null,
        createdCaseIds: created,
        preexistingCaseIds: preexisting,
      },
      artefacts: [],
    };
  }
}

interface Rendered {
  runId: string;
  workItem?: string;
  suite?: Record<string, unknown>;
  created: number[];
  preexisting: number[];
  specs: string[];
  limitations: string[];
}

/** Markdown, because the destination is an Azure DevOps work item comment. */
function render(r: Rendered): string {
  const lines: string[] = [];
  lines.push(`## agentic-qa run \`${r.runId}\``);
  lines.push("");

  if (r.suite) {
    const n = (k: string) => Number(r.suite?.[k] ?? 0);
    const verdict = r.suite["green"] === true ? "green" : "NOT green";
    lines.push(
      `**Suite: ${verdict}** — ${n("passed")} passed, ${n("failed")} failed, ${n("skipped")} skipped.`,
    );
    const failures = r.suite["failures"];
    if (Array.isArray(failures) && failures.length > 0) {
      lines.push("");
      lines.push("Failing tests:");
      for (const f of failures.slice(0, 20)) {
        const rec = asRecord(f) ?? {};
        lines.push(`- ${String(rec["title"] ?? "(untitled)")} — ${String(rec["file"] ?? "")}`);
      }
    }
  } else {
    lines.push("**Suite: not run.**");
  }

  lines.push("");
  const target = r.workItem ? ` to work item ${r.workItem}` : "";
  if (r.created.length === 0 && r.preexisting.length === 0) {
    lines.push(`No test cases are linked${target}.`);
  } else {
    const parts: string[] = [];
    if (r.created.length > 0) parts.push(`created this run: ${r.created.join(", ")}`);
    if (r.preexisting.length > 0) parts.push(`already present: ${r.preexisting.join(", ")}`);
    lines.push(
      `**Test cases linked${target}: ${r.created.length + r.preexisting.length}** (${parts.join("; ")}).`,
    );
  }

  if (r.specs.length > 0) {
    lines.push("");
    lines.push(`Spec files written: ${r.specs.map((s) => `\`${s}\``).join(", ")}`);
  }

  if (r.limitations.length > 0) {
    lines.push("");
    lines.push("**Checks not made in this environment:**");
    for (const l of r.limitations) lines.push(`- ${l}`);
  }

  lines.push("");
  lines.push(
    `_Counted from the run ledger (\`${r.runId}\`), not from the agent's account of its own work._`,
  );
  return lines.join("\n");
}
