import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StoryToTestsVerifier,
  createdCaseIds,
  parseWorkItemRef,
} from "../src/verify/story-to-tests.js";
import { completedCalls, successful, artefacts, refusals } from "../src/verify/evidence.js";
import type { AnyRunEvent } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-vfy-"));

/** Build a ledger: each entry becomes a call event plus its observation. */
function ledger(
  entries: Array<{
    tool: string;
    args?: Record<string, unknown>;
    ok?: boolean;
    result?: unknown;
    artefacts?: string[];
  }>,
  extra: AnyRunEvent[] = [],
): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  let id = 0;
  const base = { tool: "agentic-qa" as const, runId: "r", timestamp: 1_789_257_600_000 };
  for (const e of entries) {
    const callId = ++id;
    events.push({
      ...base,
      eventId: callId,
      kind: "call",
      payload: {
        server: e.tool.split(".")[0] as string,
        toolName: e.tool,
        args: e.args ?? {},
        startedAt: 0,
      },
    } as AnyRunEvent);
    events.push({
      ...base,
      eventId: ++id,
      kind: "observation",
      payload: {
        eventIdOfCall: callId,
        ok: e.ok ?? true,
        result: e.result ?? {},
        artefacts: e.artefacts ?? [],
        durationMs: 1,
      },
    } as AnyRunEvent);
  }
  return [...events, ...extra];
}

const GREEN = { passed: 6, failed: 0, skipped: 0, flaky: 0, green: true, failures: [] };

function happyRun(workspace: string) {
  mkdirSync(join(workspace, "tests"), { recursive: true });
  writeFileSync(join(workspace, "tests", "login.spec.ts"), "// implemented");
  return ledger([
    { tool: "ado.wit_work_item", args: { action: "get", id: 1 }, result: { id: 1 } },
    { tool: "fs.write_file", args: { path: "features/login.feature" } },
    { tool: "bdd2pw.to_spec", args: {}, artefacts: ["tests/login.spec.ts"] },
    { tool: "pw.run_tests", args: {}, result: GREEN },
    {
      tool: "ado.testplan_test_case_write",
      args: { action: "create", title: "AC-1", testsWorkItemId: 1 },
      result: { id: 42 },
    },
    {
      tool: "ado.testplan_test_suite_write",
      args: { action: "add_test_cases", planId: "1", testCaseIds: [42] },
    },
  ]);
}

describe("evidence", () => {
  it("pairs calls with observations, filters by tool and action, collects artefacts", () => {
    const events = happyRun(tmp());
    const calls = completedCalls(events);
    expect(calls).toHaveLength(6);
    expect(calls[0]).toMatchObject({ toolName: "ado.wit_work_item", action: "get", ok: true });
    expect(successful(calls, "ado.wit_work_item", "get")).toHaveLength(1);
    expect(successful(calls, "ado.wit_work_item", "get_batch")).toHaveLength(0);
    expect(artefacts(calls)).toEqual(["tests/login.spec.ts"]);
  });

  it("ignores a call with no observation — refused calls never look like evidence", () => {
    const events = happyRun(tmp());
    const orphan = [
      ...events,
      {
        tool: "agentic-qa",
        runId: "r",
        eventId: 99,
        timestamp: 1_789_257_600_000,
        kind: "call",
        payload: {
          server: "ado",
          toolName: "ado.wit_work_item_write",
          args: { action: "create" },
          startedAt: 0,
        },
      } as AnyRunEvent,
    ];
    expect(completedCalls(orphan)).toHaveLength(6);
  });

  it("reads refusals out of policy events", () => {
    const events = ledger(
      [],
      [
        {
          tool: "agentic-qa",
          runId: "r",
          eventId: 1,
          timestamp: 1_789_257_600_000,
          kind: "policy",
          payload: {
            toolName: "ado.wit_work_item_write",
            class: "destructive",
            decision: "refuse",
            reason: "not in the governance manifest",
          },
        } as AnyRunEvent,
      ],
    );
    expect(refusals(events)).toEqual([
      { toolName: "ado.wit_work_item_write", reason: "not in the governance manifest" },
    ]);
  });
});

describe("StoryToTestsVerifier", () => {
  const verify = (events: AnyRunEvent[], workspaceDir: string, opts = {}) =>
    new StoryToTestsVerifier({ workItem: "1", ...opts }).verify({ events, workspaceDir });

  it("is done when the story was read, the spec exists, the suite is green and cases are linked", async () => {
    const ws = tmp();
    const v = await verify(happyRun(ws), ws);
    expect(v).toEqual({ done: true, gaps: [] });
  });

  it("reports every missing piece of an empty run at once", async () => {
    const v = await verify([], tmp());
    expect(v.done).toBe(false);
    expect(v.gaps.map((g) => g.code).sort()).toEqual([
      "no-spec-written",
      "no-test-cases",
      "story-not-read",
      "suite-not-run",
    ]);
  });

  it("does not accept a read of a DIFFERENT work item as reading the story", async () => {
    const ws = tmp();
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 7 }, result: { id: 7 } },
    ]);
    const codes = (await verify(events, ws)).gaps.map((g) => g.code);
    expect(codes).toContain("story-not-read");
  });

  it("does not accept a FAILED story read", async () => {
    const ws = tmp();
    const events = ledger([
      {
        tool: "ado.wit_work_item",
        args: { action: "get", id: 1 },
        ok: false,
        result: { m: "401" },
      },
    ]);
    expect((await verify(events, ws)).gaps.map((g) => g.code)).toContain("story-not-read");
  });

  it("does not accept a spec artefact that is not on disk", async () => {
    const ws = tmp();
    const events = ledger([{ tool: "bdd2pw.to_spec", artefacts: ["tests/ghost.spec.ts"] }]);
    const gap = (await verify(events, ws)).gaps.find((g) => g.code === "no-spec-written");
    expect(gap).toBeDefined();
    expect(gap?.evidence).toMatchObject({ specArtefacts: ["tests/ghost.spec.ts"] });
  });

  it("treats a skeleton run as not done, and says why in the message", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "a.spec.ts"), "x");
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 } },
      { tool: "bdd2pw.to_spec", artefacts: ["tests/a.spec.ts"] },
      {
        tool: "pw.run_tests",
        result: { passed: 0, failed: 0, skipped: 6, flaky: 0, green: false, failures: [] },
      },
      {
        tool: "ado.testplan_test_case_write",
        args: { action: "create", testsWorkItemId: 1 },
      },
      { tool: "ado.testplan_test_suite_write", args: { action: "add_test_cases" } },
    ]);
    const v = await verify(events, ws);
    expect(v.done).toBe(false);
    const gap = v.gaps.find((g) => g.code === "suite-not-green");
    expect(gap?.message).toMatch(/6 test\(s\) are still unimplemented/);
    expect(gap?.evidence).toMatchObject({ skipped: 6 });
  });

  it("reports failures rather than skips when the suite genuinely fails", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "a.spec.ts"), "x");
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 } },
      { tool: "bdd2pw.to_spec", artefacts: ["tests/a.spec.ts"] },
      {
        tool: "pw.run_tests",
        result: { passed: 4, failed: 2, skipped: 0, green: false, failures: [{ title: "AC-2" }] },
      },
    ]);
    const gap = (await verify(events, ws)).gaps.find((g) => g.code === "suite-not-green");
    expect(gap?.message).toMatch(/4 passed, 2 failed/);
  });

  it("uses the LAST run, so a green re-run after a red one counts", async () => {
    const ws = tmp();
    const events = [
      ...ledger([
        { tool: "ado.wit_work_item", args: { action: "get", id: 1 } },
        { tool: "bdd2pw.to_spec", artefacts: ["tests/login.spec.ts"] },
        { tool: "pw.run_tests", result: { passed: 1, failed: 5, green: false } },
        { tool: "pw.run_tests", result: GREEN },
        { tool: "ado.testplan_test_case_write", args: { action: "create", testsWorkItemId: "1" } },
        { tool: "ado.testplan_test_suite_write", args: { action: "create", planId: "1" } },
      ]),
    ];
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "login.spec.ts"), "x");
    expect((await verify(events, ws)).done).toBe(true);
  });

  it("refuses to call untraceable cases done", async () => {
    const ws = tmp();
    happyRun(ws); // writes the spec file
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 }, result: { id: 1 } },
      { tool: "bdd2pw.to_spec", artefacts: ["tests/login.spec.ts"] },
      { tool: "pw.run_tests", result: GREEN },
      {
        tool: "ado.testplan_test_case_write",
        args: { action: "create", title: "AC-1", testsWorkItemId: 1 },
      },
      {
        tool: "ado.testplan_test_case_write",
        args: { action: "create", title: "orphan", testsWorkItemId: 99 },
      },
      { tool: "ado.testplan_test_suite_write", args: { action: "add_test_cases" } },
    ]);
    const v = await verify(events, ws);
    expect(v.done).toBe(false);
    expect(v.gaps[0]).toMatchObject({ code: "cases-not-linked", evidence: { titles: ["orphan"] } });
  });

  it("requires suite membership only when cases were created, and can be switched off", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "a.spec.ts"), "x");
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 } },
      { tool: "bdd2pw.to_spec", artefacts: ["tests/a.spec.ts"] },
      { tool: "pw.run_tests", result: GREEN },
      { tool: "ado.testplan_test_case_write", args: { action: "create", testsWorkItemId: 1 } },
    ]);
    expect((await verify(events, ws)).gaps.map((g) => g.code)).toEqual(["cases-not-in-suite"]);
    expect((await verify(events, ws, { requireSuiteMembership: false })).done).toBe(true);
  });

  it("honours minCases and can waive the green requirement", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "tests", "a.spec.ts"), "x");
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 } },
      { tool: "bdd2pw.to_spec", artefacts: ["tests/a.spec.ts"] },
      { tool: "pw.run_tests", result: { passed: 0, skipped: 4, failed: 0, green: false } },
      { tool: "ado.testplan_test_case_write", args: { action: "create", testsWorkItemId: 1 } },
      { tool: "ado.testplan_test_suite_write", args: { action: "add_test_cases" } },
    ]);
    const strict = await verify(events, ws, { minCases: 4, requireGreenSuite: false });
    expect(strict.gaps.map((g) => g.code)).toEqual(["no-test-cases"]);
    expect((await verify(events, ws, { requireGreenSuite: false })).done).toBe(true);
  });

  it("records what it DID see, so a gap distinguishes not-attempted from failed", async () => {
    const ws = tmp();
    const events = ledger([
      { tool: "ado.wit_work_item", args: { action: "get", id: 1 }, ok: false },
      { tool: "ado.wit_work_item", args: { action: "get_type" }, ok: true },
    ]);
    const gap = (await verify(events, ws)).gaps.find((g) => g.code === "story-not-read");
    expect(gap?.evidence?.["attempted"]).toEqual([
      { action: "get", ok: false },
      { action: "get_type", ok: true },
    ]);
  });
});

describe("createdCaseIds / parseWorkItemRef", () => {
  it("pulls case ids out of whatever field Azure DevOps used", () => {
    const events = ledger([
      { tool: "ado.testplan_test_case_write", args: { action: "create" }, result: { id: 42 } },
      {
        tool: "ado.testplan_test_case_write",
        args: { action: "create" },
        result: { workItemId: "43" },
      },
      { tool: "ado.testplan_test_case_write", args: { action: "create" }, result: "unparseable" },
    ]);
    expect(createdCaseIds(events)).toEqual([42, 43]);
  });

  it("finds the work item in the shapes people actually type", () => {
    expect(parseWorkItemRef("Write tests for AB#1")).toBe("1");
    expect(parseWorkItemRef("cover #214 please")).toBe("214");
    expect(parseWorkItemRef("tests for work item 7")).toBe("7");
    expect(parseWorkItemRef("user story 12 needs coverage")).toBe("12");
    expect(parseWorkItemRef("no reference here")).toBeUndefined();
  });
});

describe("a skipped check is recorded, not silently dropped", () => {
  it("names the missing capability when suite membership is not required", async () => {
    const v = await new StoryToTestsVerifier({
      workItem: "1",
      requireSuiteMembership: false,
    }).verify({ events: [], workspaceDir: "/tmp" });
    expect(v.limitations?.[0]).toMatch(/suite membership was not checked/);
    expect(v.limitations?.[0]).toMatch(/capabilities\.test_plans/);
  });

  it("has no limitations to report when every check was made", async () => {
    const v = await new StoryToTestsVerifier({ workItem: "1" }).verify({
      events: [],
      workspaceDir: "/tmp",
    });
    expect(v.limitations).toBeUndefined();
  });
});
