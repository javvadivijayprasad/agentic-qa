import type { PolicyClass, PolicyDecision, PolicyTable } from "../types.js";
import { DEFAULT_POLICY, POLICY_CLASSES } from "../types.js";
import type { ProposedCall } from "../runtime/model.js";
import type { ToolDescriptor } from "../runtime/tools.js";

/**
 * Result of gating one proposed call. `class` is what the call was judged to be,
 * `decision` what the table says to do about it, `reason` a human sentence that
 * goes into the ledger verbatim.
 */
export interface GateVerdict {
  toolName: string;
  class: PolicyClass;
  decision: PolicyDecision;
  reason: string;
}

export interface Gate {
  /** Classify and decide. Never executes anything. */
  judge(call: ProposedCall, tool: ToolDescriptor | undefined): GateVerdict;
}

/**
 * A2 gate: class comes from the tool descriptor (the manifest), decision from
 * the policy table. Unknown tools are `destructive` → refused by default.
 * A3 adds scope checks (work items, repos, test plans, branches) and argument
 * inspection (e.g. a push to `main` is destructive even if the tool is
 * `write_branch`).
 */
export class TableGate implements Gate {
  constructor(private readonly table: PolicyTable = DEFAULT_POLICY) {
    for (const c of POLICY_CLASSES) {
      if (!(c in table)) throw new Error(`policy table missing class "${c}"`);
    }
  }

  judge(call: ProposedCall, tool: ToolDescriptor | undefined): GateVerdict {
    if (!tool) {
      return {
        toolName: call.toolName,
        class: "destructive",
        decision: "refuse",
        reason: `unknown tool ${call.toolName}; not in the tool manifest`,
      };
    }
    const cls = tool.policyClass;
    const decision = this.table[cls];
    return { toolName: call.toolName, class: cls, decision, reason: reasonFor(cls, decision) };
  }
}

function reasonFor(cls: PolicyClass, decision: PolicyDecision): string {
  switch (cls) {
    case "read":
      return "read-only";
    case "write_workspace":
      return "writes inside the job workspace only";
    case "write_branch":
      return decision === "ask" ? "branch write requires approval" : "branch write";
    case "write_record":
      return decision === "ask"
        ? "write to a system of record requires approval"
        : "write to a system of record";
    case "destructive":
      return "destructive operation";
  }
}
