import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnyRunEvent, EventKind, PayloadByKind, RunEvent } from "../types.js";
import { EVENT_KINDS } from "../types.js";

export const LEDGER_FILE = "events.jsonl";
export const APPROVALS_DIR = "approvals";
export const SUMMARY_FILE = "summary.md";

/** Layout: `<ledgerRoot>/runs/<runId>/events.jsonl` (PLAN §0.4). */
export function runDir(ledgerRoot: string, runId: string): string {
  return join(ledgerRoot, "runs", runId);
}

export function newRunId(now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Append-only JSONL writer. One JSON object per line, flushed on every append
 * (appendFileSync opens, writes and closes — the platform tailer sees complete
 * lines only). Never rewrites or reorders.
 */
export class Ledger {
  readonly runId: string;
  readonly dir: string;
  readonly file: string;
  private nextEventId = 1;

  constructor(ledgerRoot: string, runId: string = newRunId()) {
    this.runId = runId;
    this.dir = runDir(ledgerRoot, runId);
    this.file = join(this.dir, LEDGER_FILE);
    mkdirSync(join(this.dir, APPROVALS_DIR), { recursive: true });
    if (!existsSync(this.file)) writeFileSync(this.file, "");
    // Resume support: continue numbering after any existing lines.
    const existing = readLedgerFile(this.file);
    const last = existing[existing.length - 1];
    if (last) this.nextEventId = last.eventId + 1;
  }

  append<K extends EventKind>(
    kind: K,
    payload: PayloadByKind[K],
    timestamp = Date.now(),
  ): RunEvent<K> {
    const event: RunEvent<K> = {
      tool: "agentic-qa",
      runId: this.runId,
      eventId: this.nextEventId++,
      timestamp,
      kind,
      payload,
    };
    appendFileSync(this.file, JSON.stringify(event) + "\n", "utf8");
    return event;
  }

  read(): AnyRunEvent[] {
    return readLedgerFile(this.file);
  }

  writeSummary(markdown: string): string {
    const path = join(this.dir, SUMMARY_FILE);
    writeFileSync(path, markdown, "utf8");
    return path;
  }
}

/** Parse a ledger file. Throws on a malformed line — a ledger is evidence, never "best effort". */
export function readLedgerFile(file: string): AnyRunEvent[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return parseLedger(text, file);
}

export function parseLedger(text: string, source = "<ledger>"): AnyRunEvent[] {
  const events: AnyRunEvent[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new LedgerFormatError(`${source}:${i + 1}: not valid JSON (${(e as Error).message})`);
    }
    events.push(assertRunEvent(parsed, `${source}:${i + 1}`));
  }
  assertMonotonic(events, source);
  return events;
}

export class LedgerFormatError extends Error {
  override name = "LedgerFormatError";
}

function assertRunEvent(value: unknown, where: string): AnyRunEvent {
  if (typeof value !== "object" || value === null)
    throw new LedgerFormatError(`${where}: not an object`);
  const v = value as Record<string, unknown>;
  if (v["tool"] !== "agentic-qa")
    throw new LedgerFormatError(`${where}: tool must be "agentic-qa"`);
  if (typeof v["runId"] !== "string" || v["runId"] === "")
    throw new LedgerFormatError(`${where}: runId missing`);
  if (typeof v["eventId"] !== "number" || !Number.isInteger(v["eventId"]) || v["eventId"] < 1)
    throw new LedgerFormatError(`${where}: eventId must be a positive integer`);
  if (typeof v["timestamp"] !== "number")
    throw new LedgerFormatError(`${where}: timestamp must be a number`);
  if (typeof v["kind"] !== "string" || !(EVENT_KINDS as readonly string[]).includes(v["kind"]))
    throw new LedgerFormatError(`${where}: unknown kind "${String(v["kind"])}"`);
  if (typeof v["payload"] !== "object" || v["payload"] === null)
    throw new LedgerFormatError(`${where}: payload must be an object`);
  return value as AnyRunEvent;
}

function assertMonotonic(events: AnyRunEvent[], source: string): void {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    if (cur.eventId <= prev.eventId)
      throw new LedgerFormatError(
        `${source}: eventId not increasing at line ${i + 1} (${prev.eventId} -> ${cur.eventId})`,
      );
    if (cur.runId !== prev.runId)
      throw new LedgerFormatError(`${source}: mixed runIds (${prev.runId} vs ${cur.runId})`);
  }
}
