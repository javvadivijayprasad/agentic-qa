import { describe, it, expect } from "vitest";
import {
  BasicContextBuilder,
  OrderedContextBuilder,
  DEFAULT_CAPS,
  compactResult,
  estimateTokens,
  SOURCE_CHARS,
  STEP_CHARS,
} from "../src/runtime/context.js";
import type { HistoryItem } from "../src/runtime/model.js";
import type { ToolDescriptor } from "../src/runtime/tools.js";

const tools: ToolDescriptor[] = [
  { server: "ado", name: "wit_work_item", description: "", inputSchema: {}, policyClass: "read" },
];

const item = (over: Partial<HistoryItem>): HistoryItem => ({
  toolName: "pw.run_tests",
  ok: true,
  summary: "x",
  ledgerRef: "e1",
  ...over,
});

const parts = (history: HistoryItem[], gaps?: string[]) => ({
  request: "Write tests for AB#1",
  skillInstructions: "INSTRUCTIONS",
  tools,
  history,
  ...(gaps ? { gaps } : {}),
});

describe("OrderedContextBuilder", () => {
  const builder = new OrderedContextBuilder({
    sourceTools: ["ado.wit_work_item", "fs.read_file"],
  });

  it("puts primary sources ahead of the step history, keeping each in order", () => {
    const history = [
      item({ toolName: "pw.run_tests", ledgerRef: "step-1" }),
      item({ toolName: "ado.wit_work_item", ledgerRef: "source-1" }),
      item({ toolName: "fs.write_file", ledgerRef: "step-2" }),
      item({ toolName: "fs.read_file", ledgerRef: "source-2" }),
    ];
    const { input } = builder.build(parts(history));
    expect(input.history.map((h) => h.ledgerRef)).toEqual([
      "source-1",
      "source-2",
      "step-1",
      "step-2",
    ]);
  });

  it("does not treat a FAILED source call as a source", () => {
    const history = [
      item({ toolName: "ado.wit_work_item", ok: false, ledgerRef: "failed-read" }),
      item({ toolName: "pw.run_tests", ledgerRef: "step" }),
    ];
    const { input, event } = builder.build(parts(history));
    expect(input.history.map((h) => h.ledgerRef)).toEqual(["failed-read", "step"]);
    expect(event.sections.find((s) => s.name === "sources")?.tokens).toBe(estimateTokens("[]"));
  });

  it("reports sections in source-first order and counts tokens per category", () => {
    const { event } = builder.build(parts([item({ toolName: "ado.wit_work_item" })], ["g: gap"]));
    expect(event.sections.map((s) => s.name)).toEqual([
      "instructions",
      "request",
      "tool_schemas",
      "sources",
      "history",
      "gaps",
    ]);
    expect(event.totalTokens).toBe(event.sections.reduce((n, s) => n + s.tokens, 0));
  });

  it("drops the OLDEST steps when the history cap is exceeded, and records how many", () => {
    const big = "y".repeat(400);
    const history = Array.from({ length: 10 }, (_, i) =>
      item({ toolName: "pw.run_tests", summary: big, ledgerRef: `step-${i}` }),
    );
    const tight = new OrderedContextBuilder({ caps: { history: 300 } });
    const { input, event } = tight.build(parts(history));
    const kept = input.history.map((h) => h.ledgerRef);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(10);
    expect(kept).toContain("step-9"); // newest survives
    expect(kept).not.toContain("step-0"); // oldest is dropped
    expect(kept).toEqual([...kept].sort()); // chronological order is preserved
    expect(event.droppedItems).toBe(10 - kept.length);
    expect(event.sections.find((s) => s.name === "history")?.dropped).toBe(10 - kept.length);
  });

  it("NEVER drops gate feedback, however tight the cap", () => {
    const big = "y".repeat(4000);
    const history = [
      item({
        toolName: "ado.testplan_test_case_write",
        summary: big,
        ledgerRef: "refused",
        gate: { decision: "refuse", reason: "out of scope" },
      }),
      ...Array.from({ length: 5 }, (_, i) =>
        item({ toolName: "pw.run_tests", summary: big, ledgerRef: `step-${i}` }),
      ),
    ];
    const tight = new OrderedContextBuilder({ caps: { history: 10 } });
    const { input } = tight.build(parts(history));
    expect(input.history.map((h) => h.ledgerRef)).toContain("refused");
  });

  it("keeps sources oldest-first up to their own cap, independent of the history cap", () => {
    // distinct content per item: identical sources are deduped, which is a
    // different behaviour with its own test below
    const history = Array.from({ length: 6 }, (_, i) =>
      item({
        toolName: "fs.read_file",
        summary: `${i}${"z".repeat(400)}`,
        ledgerRef: `source-${i}`,
      }),
    );
    const tight = new OrderedContextBuilder({
      sourceTools: ["fs.read_file"],
      caps: { sources: 300 },
    });
    const { input, event } = tight.build(parts(history));
    const kept = input.history.map((h) => h.ledgerRef);
    expect(kept[0]).toBe("source-0"); // the story is read first and kept first
    expect(kept).not.toContain("source-5");
    expect(event.sections.find((s) => s.name === "sources")?.dropped).toBe(6 - kept.length);
  });

  it("counts a repeated read as ONE source, not many", () => {
    const twice = [
      item({ toolName: "fs.read_file", summary: "the same file", ledgerRef: "first" }),
      item({ toolName: "fs.read_file", summary: "the same file", ledgerRef: "second" }),
      item({ toolName: "fs.read_file", summary: "a different file", ledgerRef: "third" }),
    ];
    const { input } = builder.build(parts(twice));
    expect(input.history.map((h) => h.ledgerRef)).toEqual(["first", "third"]);
  });

  it("never trims tool schemas", () => {
    const many: ToolDescriptor[] = Array.from({ length: 60 }, (_, i) => ({
      server: "ado",
      name: `t${i}`,
      description: "d".repeat(500),
      inputSchema: {},
      policyClass: "read",
    }));
    const tight = new OrderedContextBuilder({ caps: { history: 1, sources: 1 } });
    const { input } = tight.build({ ...parts([]), tools: many });
    expect(input.tools).toHaveLength(60);
  });

  it("has sane defaults and accepts partial caps", () => {
    expect(DEFAULT_CAPS).toEqual({ sources: 60000, history: 40000 });
    const b = new OrderedContextBuilder({ caps: { history: 5 } });
    expect(b.build(parts([])).event.sections).toHaveLength(5);
  });

  it("with no sourceTools behaves like the basic builder, minus the section split", () => {
    const history = [item({ ledgerRef: "a" }), item({ ledgerRef: "b" })];
    const plain = new OrderedContextBuilder();
    expect(plain.build(parts(history)).input.history.map((h) => h.ledgerRef)).toEqual(["a", "b"]);
    expect(new BasicContextBuilder().build(parts(history)).input.history).toHaveLength(2);
  });
});

describe("compactResult", () => {
  it("passes short results through untouched", () => {
    expect(compactResult({ a: 1 })).toBe('{"a":1}');
    expect(compactResult("z".repeat(STEP_CHARS))).toBe("z".repeat(STEP_CHARS));
  });

  it("says how much was cut, and that asking again will not help", () => {
    const out = compactResult("z".repeat(STEP_CHARS + 500));
    expect(out.startsWith("z".repeat(STEP_CHARS))).toBe(true);
    expect(out).toContain(`truncated: ${STEP_CHARS + 500} characters total`);
    expect(out).toContain("500 not shown");
    expect(out).toContain("Re-reading returns the same truncation");
  });

  it("gives a primary source room for a real work item", () => {
    // the failure this encodes: a 5,749-character work item cut to 400 chars of
    // banner and system fields, so the acceptance criteria never arrived
    const workItem = "x".repeat(5749);
    expect(compactResult(workItem, SOURCE_CHARS)).toBe(workItem);
    expect(compactResult(workItem)).toContain("truncated");
  });
});
