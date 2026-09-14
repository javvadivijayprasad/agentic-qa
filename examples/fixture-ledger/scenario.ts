/**
 * The scripted story→tests→run→Test Plans scenario that GENERATES events.jsonl.
 * Everything is synthetic. Regenerate with `npm run fixture:make`; the golden test
 * asserts the checked-in file equals what this scenario produces.
 */
import { Ledger } from "../../src/ledger/ledger.js";
import { ScopedGate } from "../../src/governance/policy.js";
import { ScriptedApprover } from "../../src/runtime/approval.js";
import { SteppingClock } from "../../src/runtime/clock.js";
import { runLoop, type LoopResult } from "../../src/runtime/loop.js";
import { ScriptedModel } from "../../src/runtime/model.js";
import { StubTools } from "../../src/runtime/tools.js";
import type { AgentConfig, Skill } from "../../src/types.js";
import { DEFAULT_CAPABILITIES, DEFAULT_POLICY } from "../../src/types.js";
import { ScriptedVerifier } from "../../src/verify/scripted.js";

export const FIXTURE_RUN_ID = "20260912T160000Z-fixture1";
export const FIXTURE_START = 1789228800000; // 2026-09-12T16:00:00Z
export const FIXTURE_REQUEST =
  "Write and run tests for AB#1, then record the results in Azure Test Plans.";

export const fixtureConfig: AgentConfig = {
  model: "claude-sonnet-4-6",
  prompt_version: "aqa-prompt-v0.1.0",
  budgets: { steps: 40, tokens: 400000 },
  scope: {
    work_items: ["1"],
    repos: ["orders-web"],
    test_plans: ["Sandbox Plan"],
    branches_writable: ["agent/*"],
    urls: [],
  },
  policy: DEFAULT_POLICY,
  capabilities: DEFAULT_CAPABILITIES,
};

const schema = (props: Record<string, string>) => ({
  type: "object",
  properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
  required: Object.keys(props),
});

export function fixtureTools(): StubTools {
  return new StubTools()
    .add(
      {
        server: "ado",
        name: "get_work_item",
        description: "Read a work item with acceptance criteria",
        inputSchema: schema({ id: "number" }),
        policyClass: "read",
        scopeArgs: { workItem: "id" },
      },
      {
        ok: true,
        result: {
          id: 1,
          title: "Login with valid credentials",
          acceptanceCriteria: [
            "AC-1: valid credentials land on dashboard with display name in header",
            "AC-2: invalid password shows 'Invalid username or password'",
            "AC-3: empty username or password is blocked with validation",
            "AC-4: sign out returns to login and dashboard is not reachable via back",
          ],
        },
        artefacts: [],
      },
    )
    .add(
      {
        server: "ado",
        name: "get_repo_file",
        description: "Read a file from a repository",
        inputSchema: schema({ repo: "string", path: "string" }),
        policyClass: "read",
        scopeArgs: { repo: "repo" },
      },
      {
        ok: true,
        result: { path: "src/pages/login.tsx", bytes: 2311, sha256: "d4".repeat(32) },
        artefacts: [],
      },
    )
    .add(
      {
        server: "tcg",
        name: "generate",
        description: "Generate Gherkin scenarios for a requirement",
        inputSchema: schema({ requirementId: "string", framework: "string", tagWith: "string" }),
        policyClass: "read",
      },
      {
        ok: true,
        result: {
          scenarios: [
            { id: "S1", tags: ["@ac:AC-1"], title: "Valid login lands on dashboard" },
            { id: "S2", tags: ["@ac:AC-2"], title: "Invalid password shows error" },
            { id: "S3", tags: ["@ac:AC-3"], title: "Empty fields are blocked" },
            { id: "S4", tags: ["@ac:AC-4"], title: "Sign out returns to login" },
          ],
        },
        artefacts: ["features/ab-1.feature"],
      },
    )
    .add(
      {
        server: "bdd2pw",
        name: "scaffold",
        description: "Scaffold Playwright specs from feature files",
        inputSchema: schema({ featureDir: "string", outDir: "string" }),
        policyClass: "write_workspace",
      },
      {
        ok: true,
        result: { filesWritten: 6 },
        artefacts: ["tests/ab-1.spec.ts", "pages/login.page.ts", "playwright.config.ts"],
      },
    )
    .add(
      {
        server: "playwright",
        name: "run_tests",
        description: "Run Playwright tests",
        inputSchema: schema({ project: "string", reporter: "string" }),
        policyClass: "write_workspace",
      },
      {
        ok: true,
        result: {
          total: 4,
          passed: 3,
          failed: 1,
          failures: [
            { spec: "S3", message: "expected Sign in to be disabled, but it was enabled" },
          ],
        },
        artefacts: ["playwright-report.json", "screenshots/S3-step-2.png"],
      },
    )
    .add(
      {
        server: "ado",
        name: "create_test_cases",
        description: "Create test cases in a test plan, linked to a work item",
        inputSchema: schema({ planName: "string", workItemId: "number", cases: "array" }),
        policyClass: "write_record",
        scopeArgs: { testPlan: "planName", workItem: "workItemId" },
      },
      { ok: true, result: { testCaseIds: [101, 102, 103, 104], suiteId: 7 }, artefacts: [] },
    )
    .add(
      {
        server: "ado",
        name: "record_test_run",
        description: "Record a test run with outcomes",
        inputSchema: schema({ planName: "string", outcomes: "object" }),
        policyClass: "write_record",
        scopeArgs: { testPlan: "planName" },
      },
      { ok: true, result: { runId: 55, results: 4 }, artefacts: [] },
    );
}

export function fixtureSkill(): Skill {
  return {
    name: "storyToTests",
    instructions:
      "Turn a work item into Gherkin scenarios tagged @ac:<id>, scaffold and run them, then record results in Test Plans. Read source before requirement text.",
    allowedTools: [
      "ado.get_work_item",
      "ado.get_repo_file",
      "tcg.generate",
      "bdd2pw.scaffold",
      "playwright.run_tests",
      "ado.create_test_cases",
      "ado.record_test_run",
    ],
    // A6: the story and the file read are primary sources — ordered ahead of
    // the step history and trimmed last by OrderedContextBuilder.
    sourceTools: ["ado.get_work_item", "ado.get_repo_file", "tcg.generate"],
    verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
  };
}

export function fixtureModel(): ScriptedModel {
  const u = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });
  return new ScriptedModel(
    {
      plan: {
        steps: [
          "Read work item AB#1 and its acceptance criteria",
          "Read repo files for the login page",
          "Generate Gherkin scenarios tagged @ac:AC-n",
          "Scaffold Playwright specs with bdd2pw",
          "Run Playwright",
          "Create test cases and a run in Test Plans",
        ],
        usage: u(3750, 140),
      },
      decisions: [
        { calls: [{ toolName: "ado.get_work_item", args: { id: 1 } }], usage: u(3750, 61) },
        {
          calls: [
            {
              toolName: "ado.get_repo_file",
              args: { repo: "orders-web", path: "src/pages/login.tsx" },
            },
          ],
          usage: u(4400, 58),
        },
        {
          calls: [
            {
              toolName: "tcg.generate",
              args: { requirementId: "AB-1", framework: "playwright-bdd", tagWith: "@ac:" },
            },
          ],
          usage: u(6100, 72),
        },
        {
          calls: [{ toolName: "bdd2pw.scaffold", args: { featureDir: "features", outDir: "." } }],
          usage: u(6900, 44),
        },
        {
          calls: [
            { toolName: "playwright.run_tests", args: { project: "chromium", reporter: "json" } },
          ],
          usage: u(7300, 40),
        },
        {
          calls: [
            {
              toolName: "ado.create_test_cases",
              args: { planName: "Sandbox Plan", workItemId: 1, cases: ["S1", "S2", "S3", "S4"] },
            },
            {
              toolName: "ado.record_test_run",
              args: {
                planName: "Sandbox Plan",
                outcomes: { S1: "Passed", S2: "Passed", S3: "Failed", S4: "Passed" },
              },
            },
          ],
          usage: u(8100, 96),
        },
        {
          calls: [],
          note: "4 scenarios generated for 4 acceptance criteria; 3 passed, 1 failed (S3); 4 test cases and run #55 recorded in Test Plans.",
          usage: u(8600, 22),
        },
      ],
    },
    { model: "claude-sonnet-4-6", promptVersion: "aqa-prompt-v0.1.0" },
  );
}

export async function runFixtureScenario(ledgerRoot: string): Promise<LoopResult> {
  const ledger = new Ledger(ledgerRoot, FIXTURE_RUN_ID);
  return runLoop({
    requestText: FIXTURE_REQUEST,
    model: fixtureModel(),
    tools: fixtureTools(),
    gate: new ScopedGate(fixtureConfig.policy, fixtureConfig.scope),
    approver: new ScriptedApprover([
      { decision: "approved", by: "qa.lead@example.test", at: "2026-09-12T16:01:12Z" },
    ]),
    skill: fixtureSkill(),
    ledger,
    config: fixtureConfig,
    workspaceDir: "/tmp/aqa-fixture-workspace",
    clock: new SteppingClock(FIXTURE_START, 400),
  });
}
