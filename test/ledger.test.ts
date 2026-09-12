import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Ledger,
  LedgerFormatError,
  parseLedger,
  readLedgerFile,
  newRunId,
  sha256,
} from "../src/ledger/ledger.js";
import { EVENT_KINDS } from "../src/types.js";

const FIXTURE = join(process.cwd(), "examples", "fixture-ledger", "events.jsonl");

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aqa-ledger-"));
}

describe("Ledger append", () => {
  it("creates runs/<runId>/events.jsonl and approvals/ on construction", () => {
    const root = tmp();
    const l = new Ledger(root, "run-a");
    expect(existsSync(join(root, "runs", "run-a", "events.jsonl"))).toBe(true);
    expect(existsSync(join(root, "runs", "run-a", "approvals"))).toBe(true);
    expect(l.read()).toEqual([]);
  });

  it("writes one complete JSON line per event, flushed immediately", () => {
    const root = tmp();
    const l = new Ledger(root, "run-b");
    l.append("request", { text: "hi", skill: "storyToTests", configHash: "x" }, 1000);
    // Read the raw file right away — no close/flush step required.
    const raw = readFileSync(l.file, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter(Boolean)).toHaveLength(1);
    const parsed = JSON.parse(raw.trim());
    expect(parsed).toMatchObject({
      tool: "agentic-qa",
      runId: "run-b",
      eventId: 1,
      timestamp: 1000,
      kind: "request",
    });
  });

  it("numbers events 1..n in order and round-trips through read()", () => {
    const root = tmp();
    const l = new Ledger(root, "run-c");
    l.append("request", { text: "t", skill: "s", configHash: "h" }, 1);
    l.append("plan", { steps: ["a", "b"] }, 2);
    l.append("end", { status: "done", summary: "ok", exitCode: 0 }, 3);
    const events = l.read();
    expect(events.map((e) => e.eventId)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.kind)).toEqual(["request", "plan", "end"]);
  });

  it("resumes numbering after existing lines", () => {
    const root = tmp();
    const a = new Ledger(root, "run-d");
    a.append("request", { text: "t", skill: "s", configHash: "h" }, 1);
    a.append("plan", { steps: [] }, 2);
    const b = new Ledger(root, "run-d");
    const e = b.append("end", { status: "done", summary: "", exitCode: 0 }, 3);
    expect(e.eventId).toBe(3);
    expect(readLedgerFile(b.file)).toHaveLength(3);
  });

  it("never rewrites earlier lines", () => {
    const root = tmp();
    const l = new Ledger(root, "run-e");
    l.append("request", { text: "first", skill: "s", configHash: "h" }, 1);
    const before = readFileSync(l.file, "utf8");
    l.append("plan", { steps: ["x"] }, 2);
    const after = readFileSync(l.file, "utf8");
    expect(after.startsWith(before)).toBe(true);
  });
});

describe("parseLedger", () => {
  it("parses the fixture ledger completely and covers every event kind", () => {
    const events = readLedgerFile(FIXTURE);
    expect(events.length).toBe(34);
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of EVENT_KINDS) expect(kinds.has(k)).toBe(true);
    expect(events[events.length - 1]!.kind).toBe("end");
  });

  it("ignores blank lines and CRLF", () => {
    const text = readFileSync(FIXTURE, "utf8").replace(/\n/g, "\r\n") + "\r\n\r\n";
    expect(parseLedger(text)).toHaveLength(34);
  });

  it("rejects malformed JSON with a line number", () => {
    const text =
      '{"tool":"agentic-qa","runId":"r","eventId":1,"timestamp":1,"kind":"plan","payload":{}}\nnot json\n';
    expect(() => parseLedger(text, "f")).toThrow(/f:2: not valid JSON/);
  });

  it("rejects unknown kinds, wrong tool, and non-monotonic ids", () => {
    const ok = (id: number, kind = "plan", runId = "r") =>
      JSON.stringify({ tool: "agentic-qa", runId, eventId: id, timestamp: 1, kind, payload: {} });
    expect(() => parseLedger(ok(1, "bogus"))).toThrow(LedgerFormatError);
    expect(() => parseLedger(ok(1).replace("agentic-qa", "other"))).toThrow(/tool must be/);
    expect(() => parseLedger([ok(1), ok(1)].join("\n"))).toThrow(/not increasing/);
    expect(() => parseLedger([ok(2), ok(1)].join("\n"))).toThrow(/not increasing/);
    expect(() => parseLedger([ok(1), ok(2, "plan", "other")].join("\n"))).toThrow(/mixed runIds/);
  });

  it("returns [] for a missing file", () => {
    expect(readLedgerFile(join(tmp(), "nope.jsonl"))).toEqual([]);
  });
});

describe("helpers", () => {
  it("newRunId is sortable and unique", () => {
    const a = newRunId(new Date("2026-09-12T16:00:00.000Z"));
    const b = newRunId(new Date("2026-09-12T16:00:01.000Z"));
    expect(a.startsWith("20260912T160000Z-")).toBe(true);
    expect(a < b).toBe(true);
    expect(newRunId()).not.toBe(newRunId());
  });

  it("sha256 is stable", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
