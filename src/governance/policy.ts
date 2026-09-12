import type { PolicyClass, PolicyDecision, PolicyTable, ScopeConfig } from "../types.js";
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

const RANK: Record<PolicyClass, number> = {
  read: 0,
  write_workspace: 1,
  write_branch: 2,
  write_record: 3,
  destructive: 4,
};

/** Raise a class; never lower it. */
export function raise(a: PolicyClass, b: PolicyClass): PolicyClass {
  return RANK[b] > RANK[a] ? b : a;
}

/** Tool-name fragments that are destructive regardless of the manifest class. */
export const DESTRUCTIVE_NAME_PATTERNS: RegExp[] = [
  /(^|[_.-])delete($|[_.-])/i,
  /(^|[_.-])destroy($|[_.-])/i,
  /(^|[_.-])purge($|[_.-])/i,
  /force[_-]?push/i,
  /(^|[_.-])drop($|[_.-])/i,
  /(^|[_.-])truncate($|[_.-])/i,
  /(^|[_.-])wipe($|[_.-])/i,
];

/** Branches that are never writable, whatever the allow-list says. */
export const PROTECTED_BRANCHES = ["main", "master", "release", "production", "prod"];

function validateTable(table: PolicyTable): void {
  for (const c of POLICY_CLASSES) {
    if (!(c in table)) throw new Error(`policy table missing class "${c}"`);
  }
}

/**
 * Manifest-only gate: class from the descriptor, decision from the table.
 * Unknown tools are destructive → refused. Kept for tests and for callers that
 * have no scope config; production uses `ScopedGate`.
 */
export class TableGate implements Gate {
  constructor(protected readonly table: PolicyTable = DEFAULT_POLICY) {
    validateTable(table);
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
    return {
      toolName: call.toolName,
      class: cls,
      decision: this.table[cls],
      reason: reasonFor(cls),
    };
  }
}

export interface ScopedGateOptions {
  /** When true, a `"*"` entry in a scope list is honoured. Otherwise `"*"` is ignored (PLAN §5). */
  sandbox?: boolean;
}

/**
 * Production gate (design §7). Three checks, in order:
 *  1. class raise — destructive tool names, protected or non-allow-listed branches;
 *  2. scope — every scope-bearing argument must be in the config allow-list;
 *  3. table — the (possibly raised) class looks up its decision.
 * Out-of-scope calls are refused whatever the table says.
 */
export class ScopedGate extends TableGate {
  constructor(
    table: PolicyTable,
    private readonly scope: ScopeConfig,
    private readonly opts: ScopedGateOptions = {},
  ) {
    super(table);
  }

  override judge(call: ProposedCall, tool: ToolDescriptor | undefined): GateVerdict {
    if (!tool) return super.judge(call, tool);

    let cls: PolicyClass = tool.policyClass;
    const notes: string[] = [];

    // 1a. destructive by name
    const bare = call.toolName.split(".").pop() ?? call.toolName;
    if (DESTRUCTIVE_NAME_PATTERNS.some((re) => re.test(bare))) {
      cls = raise(cls, "destructive");
      notes.push("destructive by tool name");
    }

    // 1b. branch inspection
    const branchArg = tool.scopeArgs?.branch;
    if (branchArg) {
      const branch = str(call.args[branchArg]);
      if (branch === undefined) {
        return refuse(call, cls, `argument "${branchArg}" (branch) is required for scope checks`);
      }
      if (PROTECTED_BRANCHES.includes(branch.toLowerCase())) {
        cls = raise(cls, "destructive");
        notes.push(`write to protected branch "${branch}"`);
      } else if (!matchesAny(branch, this.scope.branches_writable, this.opts.sandbox)) {
        return refuse(call, cls, `branch "${branch}" is not in branches_writable`);
      }
    }

    // 2. scope allow-lists
    const checks: Array<
      [keyof NonNullable<ToolDescriptor["scopeArgs"]>, keyof ScopeConfig, string]
    > = [
      ["workItem", "work_items", "work item"],
      ["repo", "repos", "repo"],
      ["testPlan", "test_plans", "test plan"],
    ];
    for (const [hint, listKey, label] of checks) {
      const argName = tool.scopeArgs?.[hint];
      if (!argName) continue;
      const value = str(call.args[argName]);
      if (value === undefined) {
        return refuse(call, cls, `argument "${argName}" (${label}) is required for scope checks`);
      }
      if (!matchesAny(value, this.scope[listKey], this.opts.sandbox)) {
        return refuse(call, cls, `${label} "${value}" is not in the allowed ${listKey}`);
      }
      notes.push(`${label} ${value} in scope`);
    }

    // 3. table
    const decision = this.table[cls];
    const reason = [reasonFor(cls), ...notes].join("; ");
    return { toolName: call.toolName, class: cls, decision, reason };
  }
}

function refuse(call: ProposedCall, cls: PolicyClass, reason: string): GateVerdict {
  return { toolName: call.toolName, class: cls, decision: "refuse", reason };
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Allow-list match: exact, numeric range "100-200", or glob with `*` (e.g. "agent/*").
 * A bare "*" matches everything but only when `sandbox` is true.
 */
export function matchesAny(value: string, allowed: string[], sandbox = false): boolean {
  for (const a of allowed) {
    if (a === "*") {
      if (sandbox) return true;
      continue;
    }
    if (a === value) return true;
    const range = /^(\d+)-(\d+)$/.exec(a);
    if (range && /^\d+$/.test(value)) {
      const n = Number(value);
      if (n >= Number(range[1]) && n <= Number(range[2])) return true;
      continue;
    }
    if (a.includes("*")) {
      const re = new RegExp("^" + a.split("*").map(escapeRe).join(".*") + "$");
      if (re.test(value)) return true;
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function reasonFor(cls: PolicyClass): string {
  switch (cls) {
    case "read":
      return "read-only";
    case "write_workspace":
      return "writes inside the job workspace only";
    case "write_branch":
      return "branch write";
    case "write_record":
      return "write to a system of record";
    case "destructive":
      return "destructive operation";
  }
}
