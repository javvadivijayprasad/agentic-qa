#!/usr/bin/env node
// Fixture emitter for the platform track (PLAN §3, handoff B2).
// Replays examples/fixture-ledger/events.jsonl into a real ledger location with a
// delay between lines, so the platform's tailer and approval flow can be built and
// tested before the runtime exists.
//
//   node emit.mjs --ledger <dir> [--delay-ms 200] [--approval file|none] [--exit-code 0]
//
// With --approval file it writes approvals/<id>.json requests and WAITS for the
// platform to fill in "decision" before emitting approval_resolved, exactly like
// the runtime's file mode. Exits with the fixture's end.exitCode (or --exit-code).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const ledgerRoot = opt("ledger", ".aqa");
const delayMs = Number(opt("delay-ms", "200"));
const approval = opt("approval", "none");
const forcedExit = opt("exit-code", undefined);

const src = readFileSync(join(here, "events.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const runId = src[0].runId + "-" + Date.now().toString(36);
const dir = join(ledgerRoot, "runs", runId);
mkdirSync(join(dir, "approvals"), { recursive: true });
const file = join(dir, "events.jsonl");
writeFileSync(file, "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;
for (const e of src) {
  const out = { ...e, runId, timestamp: Date.now() };
  if (approval === "file" && e.kind === "approval_requested") {
    const p = join(dir, "approvals", `${e.payload.approvalId}.json`);
    writeFileSync(p, JSON.stringify({ approvalId: e.payload.approvalId, summary: e.payload.summary, calls: e.payload.calls, decision: null }, null, 2));
    appendFileSync(file, JSON.stringify(out) + "\n");
    process.stderr.write(`[emit] waiting for decision in ${p}\n`);
    let decision = null;
    while (!decision) {
      await sleep(500);
      try { decision = JSON.parse(readFileSync(p, "utf8")).decision || null; } catch { /* partial write */ }
    }
    continue;
  }
  if (approval === "file" && e.kind === "approval_resolved") {
    const p = join(dir, "approvals", `${e.payload.approvalId}.json`);
    const rec = JSON.parse(readFileSync(p, "utf8"));
    out.payload = { ...e.payload, decision: rec.decision, by: rec.by ?? "unknown", at: rec.at ?? new Date().toISOString() };
    if (rec.decision === "denied") {
      appendFileSync(file, JSON.stringify(out) + "\n");
      const end = { ...src.at(-1), runId, timestamp: Date.now(), eventId: out.eventId + 1, payload: { status: "blocked", summary: "Approval denied by reviewer.", exitCode: 2 } };
      appendFileSync(file, JSON.stringify(end) + "\n");
      writeFileSync(join(dir, "summary.md"), `# Run ${runId}\n\nBlocked: approval denied.\n`);
      process.exit(2);
    }
  }
  if (e.kind === "end") exitCode = forcedExit !== undefined ? Number(forcedExit) : e.payload.exitCode;
  appendFileSync(file, JSON.stringify(out) + "\n");
  await sleep(delayMs);
}
writeFileSync(join(dir, "summary.md"), `# Run ${runId}\n\nFixture replay of ${src.length} events. Status: ${src.at(-1).payload.status}.\n`);
process.stderr.write(`[emit] done → ${file}\n`);
process.exit(exitCode);
