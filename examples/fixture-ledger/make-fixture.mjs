// Generates examples/fixture-ledger/events.jsonl — a synthetic but shape-complete
// story→tests→run→Test Plans run. Synthetic ids and text only (SECRETS-CHECKLIST).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runId = "20260912T160000Z-fixture1";
let id = 1;
let t = 1789228800000; // 2026-09-12T16:00:00Z
const ev = (kind, payload, dt = 400) => {
  t += dt;
  return { tool: "agentic-qa", runId, eventId: id++, timestamp: t, kind, payload };
};
const usage = (i, o) => ({ inputTokens: i, outputTokens: o });
const model = "claude-sonnet-4-6";
const promptVersion = "aqa-prompt-v0.1.0";

const events = [
  ev("request", {
    text: "Write and run tests for AB#1, then record the results in Azure Test Plans.",
    skill: "storyToTests",
    configHash: "sha256:3f9c1d0e5a7b2c4d6e8f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d",
  }),
  ev("plan", {
    steps: [
      "Read work item AB#1 and its acceptance criteria",
      "Read repo files for the login page",
      "Generate Gherkin scenarios tagged @ac:AC-n",
      "Scaffold Playwright specs with bdd2pw",
      "Run Playwright",
      "Create test cases and a run in Test Plans",
    ],
  }),
  ev("context", {
    sections: [
      { name: "instructions", sha256: "a1".repeat(32), tokens: 1420 },
      { name: "tool_schemas", sha256: "b2".repeat(32), tokens: 2210 },
      { name: "state", sha256: "c3".repeat(32), tokens: 120 },
    ],
    totalTokens: 3750,
  }),
  ev("inference", { model, promptVersion, toolName: "ado.get_work_item", args: { id: 1 }, usage: usage(3750, 61) }, 2100),
  ev("policy", { toolName: "ado.get_work_item", class: "read", decision: "execute", reason: "read-only; work item 1 in scope" }, 5),
  ev("call", { server: "ado", toolName: "get_work_item", args: { id: 1 }, startedAt: t + 5 }, 5),
  ev("observation", {
    eventIdOfCall: 6,
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
    durationMs: 640,
  }, 640),
  ev("inference", { model, promptVersion, toolName: "ado.get_repo_file", args: { repo: "orders-web", path: "src/pages/login.tsx" }, usage: usage(4400, 58) }, 1900),
  ev("policy", { toolName: "ado.get_repo_file", class: "read", decision: "execute", reason: "read-only; repo orders-web in scope" }, 5),
  ev("call", { server: "ado", toolName: "get_repo_file", args: { repo: "orders-web", path: "src/pages/login.tsx" }, startedAt: t + 5 }, 5),
  ev("observation", { eventIdOfCall: 10, ok: true, result: { path: "src/pages/login.tsx", bytes: 2311, sha256: "d4".repeat(32) }, artefacts: [], durationMs: 380 }, 380),
  ev("inference", { model, promptVersion, toolName: "tcg.generate", args: { requirementId: "AB-1", framework: "playwright-bdd", tagWith: "@ac:" }, usage: usage(6100, 72) }, 2400),
  ev("policy", { toolName: "tcg.generate", class: "read", decision: "execute", reason: "generation service call; no system-of-record write" }, 5),
  ev("call", { server: "tcg", toolName: "generate", args: { requirementId: "AB-1", framework: "playwright-bdd", tagWith: "@ac:" }, startedAt: t + 5 }, 5),
  ev("observation", {
    eventIdOfCall: 14,
    ok: true,
    result: { scenarios: [
      { id: "S1", tags: ["@ac:AC-1"], title: "Valid login lands on dashboard" },
      { id: "S2", tags: ["@ac:AC-2"], title: "Invalid password shows error" },
      { id: "S3", tags: ["@ac:AC-3"], title: "Empty fields are blocked" },
      { id: "S4", tags: ["@ac:AC-4"], title: "Sign out returns to login" },
    ] },
    artefacts: ["features/ab-1.feature"],
    durationMs: 5120,
  }, 5120),
  ev("inference", { model, promptVersion, toolName: "bdd2pw.scaffold", args: { featureDir: "features", outDir: "." }, usage: usage(6900, 44) }, 1700),
  ev("policy", { toolName: "bdd2pw.scaffold", class: "write_workspace", decision: "execute", reason: "writes inside job workspace only" }, 5),
  ev("call", { server: "bdd2pw", toolName: "scaffold", args: { featureDir: "features", outDir: "." }, startedAt: t + 5 }, 5),
  ev("observation", { eventIdOfCall: 18, ok: true, result: { filesWritten: 6 }, artefacts: ["tests/ab-1.spec.ts", "pages/login.page.ts", "playwright.config.ts"], durationMs: 2210 }, 2210),
  ev("inference", { model, promptVersion, toolName: "playwright.run_tests", args: { project: "chromium", reporter: "json" }, usage: usage(7300, 40) }, 1600),
  ev("policy", { toolName: "playwright.run_tests", class: "write_workspace", decision: "execute", reason: "execution inside job workspace" }, 5),
  ev("call", { server: "playwright", toolName: "run_tests", args: { project: "chromium", reporter: "json" }, startedAt: t + 5 }, 5),
  ev("observation", {
    eventIdOfCall: 22,
    ok: true,
    result: { total: 4, passed: 3, failed: 1, failures: [{ spec: "S3", message: "expected Sign in to be disabled, but it was enabled" }] },
    artefacts: ["playwright-report.json", "screenshots/S3-step-2.png"],
    durationMs: 18400,
  }, 18400),
  ev("inference", { model, promptVersion, toolName: "ado.create_test_cases", args: { planName: "Sandbox Plan", workItemId: 1, cases: ["S1", "S2", "S3", "S4"] }, usage: usage(8100, 96) }, 2300),
  ev("policy", { toolName: "ado.create_test_cases", class: "write_record", decision: "ask", reason: "write to Test Plans requires approval", approvalId: "apr-0001" }, 5),
  ev("approval_requested", {
    approvalId: "apr-0001",
    summary: "Create 4 test cases in plan 'Sandbox Plan' linked to AB#1, then record one test run with outcomes.",
    calls: [
      { toolName: "ado.create_test_cases", args: { planName: "Sandbox Plan", workItemId: 1, cases: ["S1", "S2", "S3", "S4"] } },
      { toolName: "ado.record_test_run", args: { planName: "Sandbox Plan", outcomes: { S1: "Passed", S2: "Passed", S3: "Failed", S4: "Passed" } } },
    ],
  }, 5),
  ev("approval_resolved", { approvalId: "apr-0001", decision: "approved", by: "qa.lead@example.test", at: "2026-09-12T16:01:12Z" }, 41000),
  ev("call", { server: "ado", toolName: "create_test_cases", args: { planName: "Sandbox Plan", workItemId: 1, cases: ["S1", "S2", "S3", "S4"] }, startedAt: t + 5 }, 5),
  ev("observation", { eventIdOfCall: 28, ok: true, result: { testCaseIds: [101, 102, 103, 104], suiteId: 7 }, artefacts: [], durationMs: 1330 }, 1330),
  ev("call", { server: "ado", toolName: "record_test_run", args: { planName: "Sandbox Plan", outcomes: { S1: "Passed", S2: "Passed", S3: "Failed", S4: "Passed" } }, startedAt: t + 5 }, 5),
  ev("observation", { eventIdOfCall: 30, ok: true, result: { runId: 55, results: 4 }, artefacts: [], durationMs: 980 }, 980),
  ev("inference", { model, promptVersion, toolName: null, args: null, usage: usage(8600, 22) }, 1500),
  ev("verify", { done: true, gaps: [] }, 900),
  ev("end", {
    status: "done",
    summary: "4 scenarios generated for 4 acceptance criteria; 3 passed, 1 failed (S3); 4 test cases and run #55 recorded in Test Plans.",
    exitCode: 0,
  }, 10),
];

const out = join(here, "events.jsonl");
writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
console.log(`wrote ${events.length} events to ${out}`);
