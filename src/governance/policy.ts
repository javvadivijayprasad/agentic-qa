import type { PolicyClass, PolicyDecision, PolicyTable, ScopeConfig } from "../types.js";
import { DEFAULT_POLICY, POLICY_CLASSES } from "../types.js";
import type { ProposedCall } from "../runtime/model.js";
import type { ScopeArgs, ToolDescriptor } from "../runtime/tools.js";

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

/**
 * Tool-name — and, since A5, ACTION-name — fragments that are destructive
 * regardless of the manifest class. `unlink` and `remove` were added when the
 * Azure DevOps server turned out to hide them inside otherwise ordinary tools
 * (`wit_work_item_link_write` does both `link` and `unlink`).
 */
export const DESTRUCTIVE_NAME_PATTERNS: RegExp[] = [
  /(^|[_.-])delete($|[_.-])/i,
  /(^|[_.-])unlink($|[_.-])/i,
  /(^|[_.-])remove($|[_.-])/i,
  /(^|[_.-])destroy($|[_.-])/i,
  /(^|[_.-])purge($|[_.-])/i,
  /force[_-]?push/i,
  /(^|[_.-])drop($|[_.-])/i,
  /(^|[_.-])truncate($|[_.-])/i,
  /(^|[_.-])wipe($|[_.-])/i,
];

/** Branches that are never writable, whatever the allow-list says. */
export const PROTECTED_BRANCHES = ["main", "master", "release", "production", "prod"];

/**
 * Resolve an action-multiplexed tool down to the one operation being asked for
 * (design §7.1, added in A5). Tools that do not multiplex pass straight
 * through. A missing or unlisted action is a refusal, never a guess: the whole
 * point of per-action classification is that `wit_backlog` may `list` but may
 * not `reorder`.
 */
export function resolveAction(
  tool: ToolDescriptor,
  args: Record<string, unknown>,
):
  | { ok: true; class: PolicyClass; scopeArgs: ScopeArgs | undefined; note?: string }
  | { ok: false; class: PolicyClass; reason: string } {
  if (!tool.actionArg) {
    return { ok: true, class: tool.policyClass, scopeArgs: tool.scopeArgs };
  }
  const action = str(args[tool.actionArg]);
  if (action === undefined) {
    return {
      ok: false,
      class: tool.policyClass,
      reason: `argument "${tool.actionArg}" (which operation) is required; ${tool.name} multiplexes several operations`,
    };
  }
  const entry = tool.actions?.[action];
  if (!entry) {
    const known = Object.keys(tool.actions ?? {});
    return {
      ok: false,
      class: "destructive",
      reason: `action "${action}" of ${tool.server}.${tool.name} is not in the governance manifest${
        known.length > 0 ? ` (classified: ${known.join(", ")})` : ""
      }`,
    };
  }
  return {
    ok: true,
    class: entry.policyClass,
    scopeArgs: entry.scopeArgs ?? tool.scopeArgs,
    note: `action "${action}"`,
  };
}

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
    const resolved = resolveAction(tool, call.args);
    if (!resolved.ok) return refuse(call, resolved.class, resolved.reason);
    const cls = resolved.class;
    return {
      toolName: call.toolName,
      class: cls,
      decision: this.table[cls],
      reason: [reasonFor(cls), resolved.note].filter(Boolean).join("; "),
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

    // 0. which operation is this? (action-multiplexed tools)
    const resolved = resolveAction(tool, call.args);
    if (!resolved.ok) return refuse(call, resolved.class, resolved.reason);
    let cls: PolicyClass = resolved.class;
    const scopeArgs = resolved.scopeArgs;
    const notes: string[] = [];
    if (resolved.note) notes.push(resolved.note);

    // 1a. destructive by name
    const bare = call.toolName.split(".").pop() ?? call.toolName;
    if (DESTRUCTIVE_NAME_PATTERNS.some((re) => re.test(bare))) {
      cls = raise(cls, "destructive");
      notes.push("destructive by tool name");
    }
    // …and by action name: `unlink`, `delete_x` and friends are destructive
    // whatever the manifest says about the tool that hosts them.
    const actionValue = tool.actionArg ? str(call.args[tool.actionArg]) : undefined;
    if (actionValue && DESTRUCTIVE_NAME_PATTERNS.some((re) => re.test(actionValue))) {
      cls = raise(cls, "destructive");
      notes.push(`destructive by action name "${actionValue}"`);
    }

    // 1b. branch inspection
    const branchArg = scopeArgs?.branch;
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

    // 1c. URL inspection (A8). Only NAVIGATION carries a URL, so this is where
    // the boundary is enforced; see `matchesUrl` for what it does not cover.
    const urlArg = scopeArgs?.url;
    if (urlArg) {
      const url = str(call.args[urlArg]);
      if (url === undefined) {
        return refuse(call, cls, `argument "${urlArg}" (url) is required for scope checks`);
      }
      if (!matchesUrl(url, this.scope.urls, this.opts.sandbox)) {
        return refuse(
          call,
          cls,
          this.scope.urls.length === 0
            ? `agent.scope.urls is empty, so the agent may not browse at all (asked for ${url})`
            : `url "${url}" is not in the allowed urls`,
        );
      }
      notes.push(`url ${url} in scope`);
    }

    // 2. scope allow-lists
    const checks: Array<[keyof ScopeArgs, keyof ScopeConfig, string]> = [
      ["workItem", "work_items", "work item"],
      ["repo", "repos", "repo"],
      ["testPlan", "test_plans", "test plan"],
    ];
    for (const [hint, listKey, label] of checks) {
      const argName = scopeArgs?.[hint];
      if (!argName) continue;
      const values = strList(call.args[argName]);
      if (values === undefined || values.length === 0) {
        return refuse(call, cls, `argument "${argName}" (${label}) is required for scope checks`);
      }
      // Every element of a list argument must be in scope; one stray id is enough to refuse.
      const bad = values.find((v) => !matchesAny(v, this.scope[listKey], this.opts.sandbox));
      if (bad !== undefined) {
        return refuse(call, cls, `${label} "${bad}" is not in the allowed ${listKey}`);
      }
      notes.push(`${label} ${values.join(",")} in scope`);
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
 * A scope-bearing argument as a list. Scalars become one-element lists; a real
 * list (e.g. `ids: [1, 2, 3]` for a batch read) keeps every element so each is
 * checked. A list containing anything that is not a string or finite number is
 * rejected outright rather than silently skipped.
 */
function strList(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = str(item);
      if (s === undefined) return undefined;
      out.push(s);
    }
    return out;
  }
  const s = str(v);
  return s === undefined ? undefined : [s];
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

/**
 * URL allow-list match (A8). An entry may be
 *   - an origin — `http://localhost:3100` allows that origin and every path under it;
 *   - a prefix — `https://staging.example.com/app` allows that path and below;
 *   - a glob — `https://*.staging.example.com/*`;
 *   - `"*"`, honoured only in sandbox mode.
 * Matching is on the parsed origin plus path, so `http://localhost:3100@evil.com`
 * and a differing port or scheme do not sneak through a string prefix test.
 *
 * WHAT THIS DOES NOT COVER, and it matters: only a navigation carries a URL
 * argument, so this is checked when the agent asks to GO somewhere. A link the
 * agent clicks, a redirect, or a script-driven navigation is not gated here.
 * The Playwright server is additionally started with `--allowed-origins` from
 * the same list, but Microsoft states plainly that this "does not serve as a
 * security boundary and does not affect redirects". Treat the pair as scoping
 * against mistakes, not as containment against a hostile page.
 */
export function matchesUrl(value: string, allowed: string[], sandbox = false): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false; // not a URL we can reason about, so not in scope
  }
  const normalised = `${url.origin}${url.pathname}`.replace(/\/$/, "");
  for (const entry of allowed) {
    if (entry === "*") {
      if (sandbox) return true;
      continue;
    }
    if (entry.includes("*")) {
      const re = new RegExp("^" + entry.split("*").map(escapeRe).join(".*") + "$");
      if (re.test(normalised) || re.test(value)) return true;
      continue;
    }
    let base: URL;
    try {
      base = new URL(entry);
    } catch {
      continue; // a malformed allow-list entry matches nothing
    }
    if (base.origin !== url.origin) continue;
    const basePath = base.pathname.replace(/\/$/, "");
    if (basePath === "" || url.pathname === basePath || url.pathname.startsWith(basePath + "/")) {
      return true;
    }
  }
  return false;
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
