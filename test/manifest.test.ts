import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MANIFEST, classify, entryClass, UNCLASSIFIED } from "../src/mcp/manifest.js";
import { FsTools } from "../src/mcp/adapters/fs.js";
import { Bdd2PwTools } from "../src/mcp/adapters/bdd2pw.js";
import { PwTools } from "../src/mcp/adapters/pw.js";
import { TcgTools } from "../src/mcp/adapters/tcg.js";
import { SynthdataTools } from "../src/mcp/adapters/synthdata.js";
import { qualify, type ToolClient, type ToolDescriptor } from "../src/runtime/tools.js";
import { McpToolClient } from "../src/mcp/client.js";
import { ScopedGate } from "../src/governance/policy.js";
import { DEFAULT_POLICY, type ScopeConfig } from "../src/types.js";

const OBSERVED = join(process.cwd(), "docs", "tools-observed.json");

/**
 * The recorded report also contains the in-process adapters (fs, bdd2pw, pw),
 * which classify themselves in trusted code. What is under test here is the
 * MCP SERVER surface — the tools a third party exposes to us — so only those
 * two servers are rebuilt.
 */
const MCP_SERVERS = ["ado", "playwright"];

describe("governance manifest", () => {
  it("declares the worst case of its own actions as the tool class", () => {
    for (const [name, entry] of Object.entries(DEFAULT_MANIFEST)) {
      expect(`${name}: ${entry.policyClass}`).toBe(`${name}: ${entryClass(entry)}`);
    }
  });

  it("gives every action-multiplexed entry an actionArg, and vice versa", () => {
    for (const [name, entry] of Object.entries(DEFAULT_MANIFEST)) {
      expect(`${name}: ${Boolean(entry.actions)}`).toBe(`${name}: ${Boolean(entry.actionArg)}`);
    }
  });

  it("classifies unknown tools and unknown servers as destructive", () => {
    expect(classify("ado.anything")).toBe(UNCLASSIFIED);
    expect(classify("evil.rm_rf").policyClass).toBe("destructive");
  });

  it("admits no Azure DevOps write beyond test cases, suites, plans, comments and branches", () => {
    const writes = Object.entries(DEFAULT_MANIFEST)
      .filter(([n]) => n.startsWith("ado."))
      .filter(([, e]) => entryClass(e) !== "read")
      .map(([n]) => n)
      .sort();
    expect(writes).toEqual([
      "ado.repo_create_branch",
      "ado.testplan_test_case_write",
      "ado.testplan_test_plan_write",
      "ado.testplan_test_suite_write",
      "ado.wit_work_item_comment_write",
    ]);
  });

  it("never classifies the arbitrary-code Playwright tools", () => {
    expect(DEFAULT_MANIFEST["playwright.browser_evaluate"]).toBeUndefined();
    expect(DEFAULT_MANIFEST["playwright.browser_run_code_unsafe"]).toBeUndefined();
  });
});

describe("manifest ↔ observed tools", () => {
  it("names only tools and actions that discovery actually recorded", () => {
    if (!existsSync(OBSERVED)) return; // report not present in a bare checkout
    const report = JSON.parse(readFileSync(OBSERVED, "utf8")) as {
      tools: Array<{ qualified: string; inputSchema: Record<string, unknown> }>;
    };
    const byName = new Map(report.tools.map((t) => [t.qualified, t]));
    for (const [name, entry] of Object.entries(DEFAULT_MANIFEST)) {
      const server = name.split(".")[0] as string;
      if (!MCP_SERVERS.includes(server)) continue;
      const observed = byName.get(name);
      expect(`${name} observed: ${observed !== undefined}`).toBe(`${name} observed: true`);
      const props = (observed?.inputSchema as { properties?: Record<string, unknown> })?.properties;
      const action = props?.["action"] as { enum?: string[]; const?: string } | undefined;
      const allowed = action?.enum ?? (action?.const ? [action.const] : undefined);
      for (const a of Object.keys(entry.actions ?? {})) {
        expect(`${name}.${a} in enum: ${allowed?.includes(a) ?? false}`).toBe(
          `${name}.${a} in enum: true`,
        );
      }
      // every scope argument must exist in the observed schema
      const scoped = [
        entry.scopeArgs,
        ...Object.values(entry.actions ?? {}).map((x) => x.scopeArgs),
      ];
      for (const s of scoped) {
        for (const arg of Object.values(s ?? {})) {
          expect(`${name} arg ${arg}: ${props?.[arg] !== undefined}`).toBe(
            `${name} arg ${arg}: true`,
          );
        }
      }
    }
  });
});

describe("in-process adapters agree with the manifest", () => {
  const clients: ToolClient[] = [
    new FsTools("/tmp"),
    new Bdd2PwTools("/tmp"),
    new PwTools("/tmp"),
    new TcgTools("http://example.invalid/generate"),
    new SynthdataTools("true", "/tmp"),
  ];

  it("declares the same class in the adapter and in the manifest", async () => {
    for (const c of clients) {
      for (const t of await c.listTools()) {
        const q = qualify(t.server, t.name);
        expect(`${q}: ${t.policyClass}`).toBe(`${q}: ${DEFAULT_MANIFEST[q]?.policyClass}`);
      }
    }
  });
});

describe("the manifest applied to the recorded MCP tool surface", () => {
  const scope: ScopeConfig = {
    work_items: ["1"],
    repos: [],
    test_plans: ["Sandbox Plan", "1"],
    branches_writable: ["agent/*"],
  };

  /** Rebuild the real descriptors from the recorded discovery report. */
  async function observedTools(): Promise<ToolDescriptor[]> {
    const report = JSON.parse(readFileSync(OBSERVED, "utf8")) as {
      tools: Array<{
        server: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>;
    };
    const byServer = new Map<string, typeof report.tools>();
    for (const t of report.tools) {
      if (!MCP_SERVERS.includes(t.server)) continue;
      byServer.set(t.server, [...(byServer.get(t.server) ?? []), t]);
    }
    const specs = [...byServer.keys()].map((name) => ({ name, command: "x", args: [] }));
    const client = new McpToolClient(specs, DEFAULT_MANIFEST, async (spec) => ({
      listTools: async () => ({ tools: byServer.get(spec.name) ?? [] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }));
    return client.listTools();
  }

  it("admits exactly the slice-1 operations and refuses the other 50", async () => {
    if (!existsSync(OBSERVED)) return;
    const gate = new ScopedGate(DEFAULT_POLICY, scope);
    const admitted: string[] = [];
    for (const t of await observedTools()) {
      const q = qualify(t.server, t.name);
      const actions = Object.keys(t.actions ?? {});
      for (const a of actions.length > 0 ? actions : [undefined]) {
        // Judge with the scope arguments satisfied, so what is measured is the
        // CLASS decision, not a missing-argument refusal.
        const args: Record<string, unknown> = a ? { [t.actionArg as string]: a } : {};
        const sa = (a ? t.actions?.[a]?.scopeArgs : undefined) ?? t.scopeArgs;
        if (sa?.workItem) args[sa.workItem] = "1";
        if (sa?.testPlan) args[sa.testPlan] = "Sandbox Plan";
        if (sa?.repo) args[sa.repo] = "orders-web";
        if (sa?.branch) args[sa.branch] = "agent/x";
        const v = gate.judge({ toolName: q, args }, t);
        if (v.decision !== "refuse") admitted.push(`${a ? `${q}.${a}` : q} → ${v.decision}`);
      }
    }
    expect(admitted.sort()).toEqual([
      "ado.testplan.list_cases → execute",
      "ado.testplan.list_plans → execute",
      "ado.testplan.list_suites → execute",
      "ado.testplan_test_case_write.create → ask",
      "ado.testplan_test_case_write.update_steps → ask",
      "ado.testplan_test_plan_write.create → ask",
      "ado.testplan_test_suite_write.add_test_cases → ask",
      "ado.testplan_test_suite_write.create → ask",
      "ado.wit_query.wiql → execute",
      "ado.wit_work_item.get → execute",
      "ado.wit_work_item.get_batch → execute",
      "ado.wit_work_item.get_type → execute",
      "ado.wit_work_item.list_comments → execute",
      "ado.wit_work_item_comment_write.add → ask",
      "playwright.browser_console_messages → execute",
      "playwright.browser_find → execute",
      "playwright.browser_network_request → execute",
      "playwright.browser_network_requests → execute",
      "playwright.browser_snapshot → execute",
      "playwright.browser_take_screenshot → execute",
    ]);
    // repo_create_branch is classified but out of reach: repos is empty here.
    expect(admitted.some((a) => a.startsWith("ado.repo_create_branch"))).toBe(false);
  });

  it("refuses every unclassified action of a tool it otherwise admits", async () => {
    if (!existsSync(OBSERVED)) return;
    const gate = new ScopedGate(DEFAULT_POLICY, scope);
    const wit = (await observedTools()).find((t) => t.name === "wit_work_item");
    expect(wit).toBeDefined();
    for (const a of ["my", "list_revisions", "list_for_iteration"]) {
      const v = gate.judge({ toolName: "ado.wit_work_item", args: { action: a, id: "1" } }, wit);
      expect(`${a}: ${v.decision}`).toBe(`${a}: refuse`);
    }
  });
});
