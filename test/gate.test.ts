import { describe, it, expect } from "vitest";
import { ScopedGate, TableGate, matchesAny, matchesUrl, raise } from "../src/governance/policy.js";
import type { ToolDescriptor } from "../src/runtime/tools.js";
import type { PolicyClass, PolicyDecision, PolicyTable, ScopeConfig } from "../src/types.js";
import { DEFAULT_POLICY, POLICY_CLASSES } from "../src/types.js";

const scope: ScopeConfig = {
  work_items: ["1", "100-199"],
  repos: ["orders-web"],
  test_plans: ["Sandbox Plan"],
  branches_writable: ["agent/*"],
  urls: ["http://localhost:3100"],
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

// ---------------------------------------------------------------------------
// A5: action-multiplexed tools (Microsoft's ADO server mixes reads and writes
// behind one tool name, selected by an `action` argument).
// ---------------------------------------------------------------------------

const multiplexed = tool({
  name: "wit_work_item",
  policyClass: "write_record", // worst case over the actions below
  actionArg: "action",
  actions: {
    get: { policyClass: "read", scopeArgs: { workItem: "id" } },
    get_batch: { policyClass: "read", scopeArgs: { workItem: "ids" } },
    comment: { policyClass: "write_record", scopeArgs: { workItem: "workItemId" } },
    unlink: { policyClass: "write_record" },
  },
});

describe("ScopedGate: action multiplexing", () => {
  const g = new ScopedGate(DEFAULT_POLICY, scope);
  const judge = (args: Record<string, unknown>) =>
    g.judge({ toolName: "ado.wit_work_item", args }, multiplexed);

  it("classifies by ACTION, not by tool: a read action executes though the tool can write", () => {
    const v = judge({ action: "get", id: 1 });
    expect(v.class).toBe("read");
    expect(v.decision).toBe("execute");
    expect(v.reason).toContain('action "get"');
  });

  it("still asks for a write action on the same tool", () => {
    expect(judge({ action: "comment", workItemId: 1 }).decision).toBe("ask");
  });

  it("refuses an action the manifest does not list, and says which are classified", () => {
    const v = judge({ action: "reorder", id: 1 });
    expect(v.decision).toBe("refuse");
    expect(v.class).toBe("destructive");
    expect(v.reason).toMatch(/action "reorder".*not in the governance manifest/);
    expect(v.reason).toContain("get, get_batch, comment, unlink");
  });

  it("refuses when the action argument is missing rather than guessing", () => {
    const v = judge({ id: 1 });
    expect(v.decision).toBe("refuse");
    expect(v.reason).toMatch(/argument "action".*is required/);
  });

  it("raises to destructive on a destructive action name", () => {
    const v = judge({ action: "unlink" });
    expect(v.class).toBe("destructive");
    expect(v.decision).toBe("refuse");
    expect(v.reason).toContain('destructive by action name "unlink"');
  });

  it("uses the per-action scope argument", () => {
    expect(judge({ action: "get", id: 999 }).decision).toBe("refuse"); // out of scope
    expect(judge({ action: "get", workItemId: 1 }).decision).toBe("refuse"); // wrong arg for this action
    expect(judge({ action: "comment", workItemId: 150 }).decision).toBe("ask"); // in range
  });

  it("checks every element of a list-valued scope argument", () => {
    expect(judge({ action: "get_batch", ids: [1, 150] }).decision).toBe("execute");
    expect(judge({ action: "get_batch", ids: [1, 999] }).decision).toBe("refuse");
    expect(judge({ action: "get_batch", ids: [] }).decision).toBe("refuse");
    expect(judge({ action: "get_batch", ids: [1, { nested: true }] }).decision).toBe("refuse");
  });

  it("TableGate resolves actions too, so a scopeless caller cannot bypass them", () => {
    const t = new TableGate(DEFAULT_POLICY);
    expect(
      t.judge({ toolName: "ado.wit_work_item", args: { action: "get" } }, multiplexed).decision,
    ).toBe("execute");
    expect(
      t.judge({ toolName: "ado.wit_work_item", args: { action: "reorder" } }, multiplexed).decision,
    ).toBe("refuse");
  });
});

// ---------------------------------------------------------------------------
// A8: URL scope. Only navigation carries a URL, so this is where the boundary
// is enforced — see the note on `matchesUrl` for what it does not cover.
// ---------------------------------------------------------------------------

describe("matchesUrl", () => {
  const allowed = ["http://localhost:3100", "https://staging.example.com/app"];

  it("allows any path under an allow-listed origin", () => {
    expect(matchesUrl("http://localhost:3100", allowed)).toBe(true);
    expect(matchesUrl("http://localhost:3100/", allowed)).toBe(true);
    expect(matchesUrl("http://localhost:3100/#/login", allowed)).toBe(true);
    expect(matchesUrl("http://localhost:3100/rest/user/whoami", allowed)).toBe(true);
  });

  it("is strict about scheme, host and port — a different port is a different app", () => {
    expect(matchesUrl("http://localhost:3000/", allowed)).toBe(false);
    expect(matchesUrl("https://localhost:3100/", allowed)).toBe(false);
    expect(matchesUrl("http://127.0.0.1:3100/", allowed)).toBe(false);
  });

  it("cannot be fooled by a prefix that is not an origin", () => {
    // classic userinfo trick: the real host here is evil.com
    expect(matchesUrl("http://localhost:3100@evil.com/", allowed)).toBe(false);
    expect(matchesUrl("http://localhost:3100.evil.com/", allowed)).toBe(false);
    expect(matchesUrl("https://staging.example.com.evil.com/app", allowed)).toBe(false);
  });

  it("honours a path prefix, and does not leak to a sibling path", () => {
    expect(matchesUrl("https://staging.example.com/app", allowed)).toBe(true);
    expect(matchesUrl("https://staging.example.com/app/login", allowed)).toBe(true);
    expect(matchesUrl("https://staging.example.com/admin", allowed)).toBe(false);
    expect(matchesUrl("https://staging.example.com/application", allowed)).toBe(false);
  });

  it("supports globs, ignores malformed entries, and refuses non-URLs", () => {
    expect(matchesUrl("https://a.staging.example.com/x", ["https://*.staging.example.com/*"])).toBe(
      true,
    );
    expect(matchesUrl("http://localhost:3100/", ["not a url"])).toBe(false);
    expect(matchesUrl("javascript:alert(1)", allowed)).toBe(false);
    expect(matchesUrl("not a url", allowed)).toBe(false);
  });

  it('honours "*" only in sandbox mode', () => {
    expect(matchesUrl("https://anything.example.com/", ["*"])).toBe(false);
    expect(matchesUrl("https://anything.example.com/", ["*"], true)).toBe(true);
  });
});

describe("ScopedGate: url scope", () => {
  const navigate = tool({
    server: "playwright",
    name: "browser_navigate",
    policyClass: "write_workspace",
    scopeArgs: { url: "url" },
  });
  const judge = (s: ScopeConfig, url?: unknown) =>
    new ScopedGate(DEFAULT_POLICY, s).judge(
      { toolName: "playwright.browser_navigate", args: url === undefined ? {} : { url } },
      navigate,
    );

  it("executes a navigation inside scope and records the url in the reason", () => {
    const v = judge(scope, "http://localhost:3100/#/login");
    expect(v.decision).toBe("execute");
    expect(v.reason).toContain("url http://localhost:3100/#/login in scope");
  });

  it("refuses a navigation outside scope", () => {
    const v = judge(scope, "https://example.com/");
    expect(v.decision).toBe("refuse");
    expect(v.reason).toMatch(/is not in the allowed urls/);
  });

  it("refuses, with a plain reason, when the agent may not browse at all", () => {
    const v = judge({ ...scope, urls: [] }, "http://localhost:3100/");
    expect(v.decision).toBe("refuse");
    expect(v.reason).toMatch(/may not browse at all/);
  });

  it("refuses a navigation with no url rather than guessing", () => {
    expect(judge(scope).decision).toBe("refuse");
  });
});
