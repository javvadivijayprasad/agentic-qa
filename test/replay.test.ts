import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readLedgerFile } from "../src/ledger/ledger.js";
import { computeStats, renderLine, renderMarkdown } from "../src/ledger/replay.js";
import type { AnyRunEvent } from "../src/types.js";

const FIXTURE = join(process.cwd(), "examples", "fixture-ledger", "events.jsonl");
const events = readLedgerFile(FIXTURE);

describe("computeStats", () => {
  it("counts inferences, calls, approvals, refusals and tokens from the fixture", () => {
    const s = computeStats(events);
    expect(s.events).toBe(42);
    expect(s.inferences).toBe(8);
    expect(s.calls).toBe(7);
    expect(s.failedCalls).toBe(0);
    expect(s.approvals).toBe(1);
    expect(s.refusals).toBe(0);
    expect(s.status).toBe("done");
    expect(s.inputTokens).toBeGreaterThan(0);
    expect(s.wallMs).toBeGreaterThan(0);
  });

  it("reports incomplete when there is no end event", () => {
    const s = computeStats(events.slice(0, 5));
    expect(s.status).toBe("incomplete");
  });
});

describe("renderLine (platform run-page messages — keep stable)", () => {
  const byKind = (k: AnyRunEvent["kind"]) => events.find((e) => e.kind === k)!;
  it("renders each kind in the documented shape", () => {
    expect(renderLine(byKind("request"))).toMatch(/^Agent started: ".*" \(skill storyToTests\)$/);
    expect(renderLine(byKind("plan"))).toMatch(/^Plan: 6 steps — /);
    expect(renderLine(byKind("inference"))).toBe("Agent chose ado.get_work_item");
    expect(renderLine(byKind("policy"))).toBe(
      "Gate: read → execute (read-only; work item 1 in scope)",
    );
    expect(renderLine(byKind("approval_requested"))).toMatch(
      /^Approval needed: Approve 2 calls: ado\.create_test_cases/,
    );
    expect(renderLine(byKind("approval_resolved"))).toBe(
      "Approval approved by qa.lead@example.test",
    );
    expect(renderLine(byKind("call"))).toBe("Calling ado.get_work_item");
    expect(renderLine(byKind("observation"))).toMatch(/^call #\d+ → ok \(\d+ ms\)$/);
    expect(renderLine(byKind("verify"))).toBe("Verifier: done");
    expect(renderLine(byKind("end"))).toMatch(/^Agent finished: done — /);
  });

  it("renders a failed observation with the first line of the error", () => {
    const e: AnyRunEvent = {
      tool: "agentic-qa",
      runId: "r",
      eventId: 9,
      timestamp: 1,
      kind: "observation",
      payload: {
        eventIdOfCall: 8,
        ok: false,
        result: { message: "boom\nsecond line" },
        artefacts: [],
        durationMs: 5,
      },
    };
    expect(renderLine(e)).toBe("call #8 → failed: boom");
  });

  it("renders goal-reached inference", () => {
    const goal = events.find((e) => e.kind === "inference" && e.payload.toolName === null)!;
    expect(renderLine(goal)).toBe("Agent declared goal reached");
  });
});

describe("renderMarkdown", () => {
  it("produces a report with header, stats and a 34-row timeline", () => {
    const md = renderMarkdown(events);
    expect(md).toMatch(/^# agentic-qa replay — run 20260912T160000Z-fixture1/);
    expect(md).toContain("**Status:** done");
    expect(md).toContain("**Tool calls:** 7 (0 failed)");
    const rows = md.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    expect(rows).toHaveLength(42);
    expect(md).toContain("no tool or model calls were made");
  });

  it("lists verifier gaps when present", () => {
    const withGaps = events.map((e) =>
      e.kind === "verify"
        ? {
            ...e,
            payload: {
              done: false,
              gaps: [{ code: "AC_UNCOVERED", message: "AC-3 has no scenario" }],
            },
          }
        : e,
    ) as AnyRunEvent[];
    const md = renderMarkdown(withGaps);
    expect(md).toContain("## Verifier gaps");
    expect(md).toContain("`AC_UNCOVERED` — AC-3 has no scenario");
  });

  it("handles an empty ledger", () => {
    expect(renderMarkdown([])).toContain("_Empty ledger._");
  });
});
