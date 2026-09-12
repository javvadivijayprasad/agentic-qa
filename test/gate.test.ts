import { describe, it, expect } from "vitest";
import { ScopedGate, TableGate, matchesAny, raise } from "../src/governance/policy.js";
import type { ToolDescriptor } from "../src/runtime/tools.js";
import type { PolicyClass, PolicyDecision, PolicyTable, ScopeConfig } from "../src/types.js";
import { DEFAULT_POLICY, POLICY_CLASSES } from "../src/types.js";

const scope: ScopeConfig = {
  work_items: ["1", "100-199"],
  repos: ["orders-web"],
  test_plans: ["Sandbox Plan"],
  branches_writable: ["agent/*"],
};

const tool = (over: Partial<ToolDescriptor>): ToolDescriptor => ({
  server: "ado",
  name: "t",
  description: "",
  inputSchema: {},
  policyClass: "read",
  ...over,
});

describe("matchesAny", () => {
  it("exact, range, glob, and sandbox-only wildcard", () => {
    expect(matchesAny("1", ["1"])).toBe(true);
    expect(matchesAny("150", ["100-199"])).toBe(true);
    expect(matchesAny("200", ["100-199"])).toBe(false);
    expect(matchesAny("agent/login", ["agent/*"])).toBe(true);
    expect(matchesAny("feature/x", ["agent/*"])).toBe(false);
    expect(matchesAny("anything", ["*"])).toBe(false);
    expect(matchesAny("anything", ["*"], true)).toBe(true);
    expect(matchesAny("a.b", ["a.b"])).toBe(true);
    expect(matchesAny("axb", ["a.b"])).toBe(false); // dot is literal, not regex
  });
});

describe("raise", () => {
  it("never lowers a class", () => {
    expect(raise("read", "destructive")).toBe("destructive");
    expect(raise("destructive", "read")).toBe("destructive");
    expect(raise("write_branch", "write_workspace")).toBe("write_branch");
  });
});

describe("TableGate", () => {
  it("table-driven: every class maps to its configured decision", () => {
    const decisions: PolicyDecision[] = ["execute", "ask", "refuse"];
    for (const cls of POLICY_CLASSES) {
      for (const d of decisions) {
        const table = { ...DEFAULT_POLICY, [cls]: d } as PolicyTable;
        const g = new TableGate(table);
        const v = g.judge(
          { toolName: "s.x", args: {} },
          tool({ server: "s", name: "x", policyClass: cls }),
        );
        expect(v.class).toBe(cls);
        expect(v.decision).toBe(d);
      }
    }
  });

  it("refuses an unknown tool as destructive", () => {
    const v = new TableGate().judge({ toolName: "s.nope", args: {} }, undefined);
    expect(v).toMatchObject({ class: "destructive", decision: "refuse" });
  });

  it("rejects an incomplete policy table", () => {
    expect(() => new TableGate({ read: "execute" } as unknown as PolicyTable)).toThrow(
      /missing class/,
    );
  });
});

describe("ScopedGate — design §7 table reproduced", () => {
  const g = new ScopedGate(DEFAULT_POLICY, scope);

  const cases: Array<{
    name: string;
    tool: ToolDescriptor;
    args: Record<string, unknown>;
    cls: PolicyClass;
    decision: PolicyDecision;
    reason: RegExp;
  }> = [
    {
      name: "read in-scope work item → execute",
      tool: tool({ name: "get_work_item", scopeArgs: { workItem: "id" } }),
      args: { id: 1 },
      cls: "read",
      decision: "execute",
      reason: /work item 1 in scope/,
    },
    {
      name: "read in-range work item → execute",
      tool: tool({ name: "get_work_item", scopeArgs: { workItem: "id" } }),
      args: { id: 150 },
      cls: "read",
      decision: "execute",
      reason: /in scope/,
    },
    {
      name: "read out-of-scope work item → refuse",
      tool: tool({ name: "get_work_item", scopeArgs: { workItem: "id" } }),
      args: { id: 999 },
      cls: "read",
      decision: "refuse",
      reason: /work item "999" is not in the allowed work_items/,
    },
    {
      name: "scope-bearing argument missing → refuse",
      tool: tool({ name: "get_work_item", scopeArgs: { workItem: "id" } }),
      args: {},
      cls: "read",
      decision: "refuse",
      reason: /"id" \(work item\) is required/,
    },
    {
      name: "write_workspace → execute (no scope args)",
      tool: tool({ server: "bdd2pw", name: "scaffold", policyClass: "write_workspace" }),
      args: { featureDir: "features" },
      cls: "write_workspace",
      decision: "execute",
      reason: /workspace/,
    },
    {
      name: "write_record to allowed test plan → ask",
      tool: tool({
        name: "create_test_cases",
        policyClass: "write_record",
        scopeArgs: { testPlan: "planName" },
      }),
      args: { planName: "Sandbox Plan" },
      cls: "write_record",
      decision: "ask",
      reason: /system of record; test plan Sandbox Plan in scope/,
    },
    {
      name: "write_record to other test plan → refuse",
      tool: tool({
        name: "create_test_cases",
        policyClass: "write_record",
        scopeArgs: { testPlan: "planName" },
      }),
      args: { planName: "Production Plan" },
      cls: "write_record",
      decision: "refuse",
      reason: /not in the allowed test_plans/,
    },
    {
      name: "write_branch to agent/* → ask",
      tool: tool({
        name: "push_branch",
        policyClass: "write_branch",
        scopeArgs: { branch: "branch", repo: "repo" },
      }),
      args: { branch: "agent/ab-1-tests", repo: "orders-web" },
      cls: "write_branch",
      decision: "ask",
      reason: /branch write; repo orders-web in scope/,
    },
    {
      name: "write_branch to main → destructive → refuse",
      tool: tool({
        name: "push_branch",
        policyClass: "write_branch",
        scopeArgs: { branch: "branch", repo: "repo" },
      }),
      args: { branch: "main", repo: "orders-web" },
      cls: "destructive",
      decision: "refuse",
      reason: /protected branch "main"/,
    },
    {
      name: "write_branch to non-allow-listed branch → refuse",
      tool: tool({
        name: "push_branch",
        policyClass: "write_branch",
        scopeArgs: { branch: "branch" },
      }),
      args: { branch: "feature/x" },
      cls: "write_branch",
      decision: "refuse",
      reason: /not in branches_writable/,
    },
    {
      name: "destructive by name (delete_*) raises a read tool → refuse",
      tool: tool({ name: "delete_test_plan", policyClass: "read" }),
      args: {},
      cls: "destructive",
      decision: "refuse",
      reason: /destructive by tool name/,
    },
    {
      name: "force-push raises to destructive",
      tool: tool({ name: "forcePush", policyClass: "write_branch", scopeArgs: { branch: "b" } }),
      args: { b: "agent/x" },
      cls: "destructive",
      decision: "refuse",
      reason: /destructive/,
    },
    {
      name: "repo out of scope → refuse",
      tool: tool({ name: "get_repo_file", scopeArgs: { repo: "repo" } }),
      args: { repo: "payments-api", path: "x" },
      cls: "read",
      decision: "refuse",
      reason: /repo "payments-api" is not in the allowed repos/,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const v = g.judge({ toolName: `${c.tool.server}.${c.tool.name}`, args: c.args }, c.tool);
      expect(v.class).toBe(c.cls);
      expect(v.decision).toBe(c.decision);
      expect(v.reason).toMatch(c.reason);
    });
  }

  it("a tenant-tightened table is honoured (write_record → refuse)", () => {
    const strict = new ScopedGate({ ...DEFAULT_POLICY, write_record: "refuse" }, scope);
    const v = strict.judge(
      { toolName: "ado.create_test_cases", args: { planName: "Sandbox Plan" } },
      tool({
        name: "create_test_cases",
        policyClass: "write_record",
        scopeArgs: { testPlan: "planName" },
      }),
    );
    expect(v.decision).toBe("refuse");
  });

  it('"*" in scope lists is ignored unless sandbox mode is on', () => {
    const wild: ScopeConfig = { ...scope, work_items: ["*"] };
    const t = tool({ name: "get_work_item", scopeArgs: { workItem: "id" } });
    expect(
      new ScopedGate(DEFAULT_POLICY, wild).judge(
        { toolName: "ado.get_work_item", args: { id: 5 } },
        t,
      ).decision,
    ).toBe("refuse");
    expect(
      new ScopedGate(DEFAULT_POLICY, wild, { sandbox: true }).judge(
        { toolName: "ado.get_work_item", args: { id: 5 } },
        t,
      ).decision,
    ).toBe("execute");
  });

  it("unknown tool still refused", () => {
    expect(g.judge({ toolName: "x.y", args: {} }, undefined).decision).toBe("refuse");
  });
});
