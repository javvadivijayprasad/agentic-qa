import type {
  AnyRunEvent,
  CallPayload,
  ObservationPayload,
  RunEvent,
  PolicyPayload,
} from "../types.js";

/**
 * One completed tool call: what was asked for, and what came back. A verifier
 * reads ONLY this — the ledger's record of what actually happened — never the
 * model's claims about what it did. If a call has no observation (refused,
 * denied, or the run ended first) it does not appear here at all.
 */
export interface CallRecord {
  eventId: number;
  /**
   * SERVER-QUALIFIED, e.g. "ado.wit_work_item" — the same spelling the gate,
   * the manifest and a skill's `allowedTools` use, so a verifier can name a
   * tool the one way it is named everywhere else.
   *
   * A `call` event stores `server` and `toolName` separately and the toolName
   * bare ("wit_work_item"), so it is joined back together here. This was a real
   * bug: the verifier compared qualified names against bare ones, matched
   * nothing, and reported every check as "never attempted" on a run that had
   * done all of them. The unit fixtures had encoded the qualified spelling that
   * the loop never actually writes, so the whole suite was green while the
   * verifier could not pass a single check against a real ledger.
   */
  toolName: string;
  server: string;
  /** The `action` argument for action-multiplexed tools, when present. */
  action: string | undefined;
  args: Record<string, unknown>;
  ok: boolean;
  result: unknown;
  artefacts: string[];
}

/** Pair `call` events with their `observation` events. */
export function completedCalls(events: AnyRunEvent[]): CallRecord[] {
  const calls = new Map<number, RunEvent<"call">>();
  for (const e of events) if (e.kind === "call") calls.set(e.eventId, e as RunEvent<"call">);

  const out: CallRecord[] = [];
  for (const e of events) {
    if (e.kind !== "observation") continue;
    const obs = e.payload as ObservationPayload;
    const call = calls.get(obs.eventIdOfCall);
    if (!call) continue;
    const p = call.payload as CallPayload;
    const action = typeof p.args["action"] === "string" ? p.args["action"] : undefined;
    out.push({
      eventId: call.eventId,
      toolName: qualifiedName(p.server, p.toolName),
      server: p.server,
      action,
      args: p.args,
      ok: obs.ok,
      result: obs.result,
      artefacts: obs.artefacts,
    });
  }
  return out;
}

/**
 * `server` + bare name → "server.name". A ledger written by an older build (or
 * a hand-built fixture) may already carry the qualified spelling; qualifying it
 * twice would produce "ado.ado.wit_work_item" and break exactly the comparison
 * this exists to fix, so an already-prefixed name is left alone.
 */
function qualifiedName(server: string, toolName: string): string {
  return toolName.startsWith(`${server}.`) ? toolName : `${server}.${toolName}`;
}

/** Successful calls of one tool, optionally narrowed to one action. */
export function successful(calls: CallRecord[], toolName: string, action?: string): CallRecord[] {
  return calls.filter(
    (c) => c.ok && c.toolName === toolName && (action === undefined || c.action === action),
  );
}

/** Every artefact path any successful call reported, in order, de-duplicated. */
export function artefacts(calls: CallRecord[]): string[] {
  const seen = new Set<string>();
  for (const c of calls) if (c.ok) for (const a of c.artefacts) seen.add(a);
  return [...seen];
}

/** Gate refusals recorded during the run — useful context for a "blocked" gap. */
export function refusals(events: AnyRunEvent[]): Array<{ toolName: string; reason: string }> {
  return events
    .filter((e) => e.kind === "policy")
    .map((e) => e.payload as PolicyPayload)
    .filter((p) => p.decision === "refuse")
    .map((p) => ({ toolName: p.toolName, reason: p.reason }));
}

/**
 * Read a field out of a tool result that may be a JSON object, an array, or a
 * `{ value: [...] }` envelope (Azure DevOps wraps collections that way).
 */
export function asRecord(result: unknown): Record<string, unknown> | undefined {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

export function asArray(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rec = asRecord(result);
  if (rec && Array.isArray(rec["value"])) return rec["value"];
  return [];
}

/** Number-or-numeric-string field, e.g. a work item id that arrives as either. */
export function numberField(source: unknown, ...names: string[]): number | undefined {
  const rec = asRecord(source);
  if (!rec) return undefined;
  for (const n of names) {
    const v = rec[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  }
  return undefined;
}
