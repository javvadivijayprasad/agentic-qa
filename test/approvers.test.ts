import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  FileApprover,
  TerminalApprover,
  type FileApprovalRecord,
} from "../src/runtime/approvers.js";
import type { ApprovalRequest } from "../src/runtime/approval.js";
import { Ledger, APPROVALS_DIR } from "../src/ledger/ledger.js";
import { TableGate } from "../src/governance/policy.js";
import { SteppingClock } from "../src/runtime/clock.js";
import { runLoop } from "../src/runtime/loop.js";
import { ScriptedModel } from "../src/runtime/model.js";
import { StubTools } from "../src/runtime/tools.js";
import { ScriptedVerifier } from "../src/verify/scripted.js";
import { fixtureConfig } from "../examples/fixture-ledger/scenario.js";

const req: ApprovalRequest = {
  approvalId: "apr-0001",
  summary: "Approve 1 call: s.write(a=1)",
  calls: [{ toolName: "s.write", args: { a: 1 } }],
};

describe("TerminalApprover", () => {
  async function run(answer: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (d) => (printed += String(d)));
    const a = new TerminalApprover({ input, output }, "vijay");
    const p = a.ask(req);
    input.write(answer + "\n");
    const r = await p;
    return { r, printed };
  }

  it("y → approved, records who and when", async () => {
    const { r, printed } = await run("y");
    expect(r.decision).toBe("approved");
    expect(r.by).toBe("vijay");
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(printed).toContain("apr-0001");
    expect(printed).toContain("s.write");
  });

  it("anything else → denied (default is No)", async () => {
    expect((await run("n")).r.decision).toBe("denied");
    expect((await run("")).r.decision).toBe("denied");
    expect((await run("maybe")).r.decision).toBe("denied");
  });

  it("stdin closing without an answer → denied", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = new TerminalApprover({ input, output }, "x").ask(req);
    input.end();
    expect((await p).decision).toBe("denied");
  });
});

describe("FileApprover", () => {
  function fakeTime() {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("writes the request file with decision:null and returns once a decision is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aqa-appr-"));
    const time = fakeTime();
    let polls = 0;
    const a = new FileApprover({
      dir,
      pollMs: 100,
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        // The "platform" decides on the third poll.
        if (++polls === 3) {
          const f = join(dir, "apr-0001.json");
          const rec = JSON.parse(readFileSync(f, "utf8")) as FileApprovalRecord;
          writeFileSync(
            f,
            JSON.stringify({
              ...rec,
              decision: "approved",
              by: "lead@example.test",
              at: "2026-09-12T16:01:12Z",
            }),
          );
        }
      },
    });
    const p = a.ask(req);
    // Request file exists immediately with decision null.
    const initial = JSON.parse(
      readFileSync(join(dir, "apr-0001.json"), "utf8"),
    ) as FileApprovalRecord;
    expect(initial.decision).toBeNull();
    expect(initial.summary).toBe(req.summary);
    expect(initial.calls).toEqual(req.calls);
    const r = await p;
    expect(r).toEqual({
      decision: "approved",
      by: "lead@example.test",
      at: "2026-09-12T16:01:12Z",
    });
    expect(polls).toBe(3);
  });

  it("times out → denied by 'timeout'", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aqa-appr-"));
    const time = fakeTime();
    const a = new FileApprover({
      dir,
      pollMs: 1000,
      timeoutMs: 5000,
      now: time.now,
      sleep: time.sleep,
    });
    const r = await a.ask(req);
    expect(r.decision).toBe("denied");
    expect(r.by).toBe("timeout");
    expect(existsSync(join(dir, "apr-0001.json"))).toBe(true);
  });

  it("ignores a partially written / invalid file and keeps polling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aqa-appr-"));
    const time = fakeTime();
    let polls = 0;
    const f = join(dir, "apr-0001.json");
    const a = new FileApprover({
      dir,
      pollMs: 10,
      timeoutMs: 10_000,
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        polls++;
        if (polls === 1) writeFileSync(f, '{"approvalId":"apr-0001","decision":"appro'); // truncated
        if (polls === 2)
          writeFileSync(f, JSON.stringify({ approvalId: "apr-0001", decision: "denied", by: "r" }));
      },
    });
    const r = await a.ask(req);
    expect(r.decision).toBe("denied");
    expect(r.by).toBe("r");
  });

  it("denied with missing by/at gets safe defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aqa-appr-"));
    const time = fakeTime();
    const f = join(dir, "apr-0001.json");
    const a = new FileApprover({
      dir,
      pollMs: 10,
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        writeFileSync(f, JSON.stringify({ decision: "denied" }));
      },
    });
    const r = await a.ask(req);
    expect(r.by).toBe("unknown");
    expect(r.at).toMatch(/T/);
  });
});

// ---------------------------------------------------------------------------
// The handoff contract, exercised end to end: the loop asks, the ledger
// announces, a "platform" answers by writing the file, the run carries on.
// Every assertion here is something the platform track depends on.
// ---------------------------------------------------------------------------

describe("file approval, as the platform actually drives it", () => {
  const u = { inputTokens: 10, outputTokens: 1 };

  function harness() {
    const dir = mkdtempSync(join(tmpdir(), "aqa-joint-"));
    const ledger = new Ledger(dir, "run-joint");
    const approvals = join(ledger.dir, APPROVALS_DIR);
    const tools = new StubTools().add(
      {
        server: "ado",
        name: "case_write",
        description: "",
        inputSchema: {},
        policyClass: "write_record",
      },
      { ok: true, result: { id: 7 }, artefacts: [] },
    );
    return { ledger, approvals, tools };
  }

  async function runWith(
    approver: FileApprover,
    ledger: Ledger,
    tools: StubTools,
  ): Promise<ReturnType<typeof runLoop>> {
    return runLoop({
      requestText: "do it",
      model: new ScriptedModel({
        plan: { steps: [], usage: u },
        decisions: [
          { calls: [{ toolName: "ado.case_write", args: { action: "create" } }], usage: u },
          { calls: [], usage: u },
        ],
      }),
      tools,
      gate: new TableGate(),
      approver,
      skill: {
        name: "t",
        instructions: "",
        allowedTools: ["ado.case_write"],
        verifier: new ScriptedVerifier([{ done: true, gaps: [] }]),
      },
      ledger,
      config: fixtureConfig,
      workspaceDir: "/tmp",
      clock: new SteppingClock(1_000_000, 10),
    });
  }

  /** Answer the request the moment its file appears — what the platform does. */
  function answerWhenAsked(approvals: string, decision: "approved" | "denied", by = "platform") {
    const timer = setInterval(() => {
      if (!existsSync(approvals)) return;
      for (const f of readdirSync(approvals)) {
        const path = join(approvals, f);
        const rec = JSON.parse(readFileSync(path, "utf8")) as FileApprovalRecord;
        if (rec.decision !== null) continue;
        writeFileSync(
          path,
          JSON.stringify({ ...rec, decision, by, at: new Date().toISOString() }, null, 2),
          "utf8",
        );
      }
    }, 5);
    return () => clearInterval(timer);
  }

  it("completes the run when the platform approves, and records who did", async () => {
    const { ledger, approvals, tools } = harness();
    const stop = answerWhenAsked(approvals, "approved");
    try {
      const r = await runWith(new FileApprover({ dir: approvals, pollMs: 5 }), ledger, tools);
      expect(r.status).toBe("done");
    } finally {
      stop();
    }
    const resolved = ledger.read().find((e) => e.kind === "approval_resolved");
    expect(resolved?.payload).toMatchObject({ decision: "approved", by: "platform" });
    expect(ledger.read().filter((e) => e.kind === "call")).toHaveLength(1);
  });

  it("blocks the run when the platform denies, and the call never happens", async () => {
    const { ledger, approvals, tools } = harness();
    const stop = answerWhenAsked(approvals, "denied");
    try {
      const r = await runWith(new FileApprover({ dir: approvals, pollMs: 5 }), ledger, tools);
      expect(r.status).toBe("blocked");
    } finally {
      stop();
    }
    expect(ledger.read().filter((e) => e.kind === "call")).toHaveLength(0);
  });

  it("announces the approval in the ledger BEFORE the file appears", async () => {
    // The platform tails the ledger, sees approval_requested, then looks for
    // the file — which is written a moment later. It must treat "not there
    // yet" as "still arriving", not as an error.
    const { ledger, approvals, tools } = harness();
    const seen: string[] = [];
    const timer = setInterval(() => {
      const announced = ledger.read().some((e) => e.kind === "approval_requested");
      if (announced && seen.length === 0) seen.push(existsSync(approvals) ? "file" : "event-first");
    }, 1);
    const stop = answerWhenAsked(approvals, "approved");
    try {
      await runWith(new FileApprover({ dir: approvals, pollMs: 5 }), ledger, tools);
    } finally {
      stop();
      clearInterval(timer);
    }
    const requested = ledger.read().find((e) => e.kind === "approval_requested");
    expect(requested?.payload).toMatchObject({ approvalId: "apr-0001" });
    // The file is named by the approvalId the ledger announced — that is the
    // whole of the contract between the two tracks.
    expect(existsSync(join(approvals, "apr-0001.json"))).toBe(true);
  });

  it("treats silence as no, and says the timeout did it", async () => {
    const { ledger, approvals, tools } = harness();
    const r = await runWith(
      new FileApprover({ dir: approvals, pollMs: 5, timeoutMs: 60 }),
      ledger,
      tools,
    );
    expect(r.status).toBe("blocked");
    expect(ledger.read().find((e) => e.kind === "approval_resolved")?.payload).toMatchObject({
      decision: "denied",
      by: "timeout",
    });
  });

  it("carries the batch into the file, so a reviewer sees every call", async () => {
    const { ledger, approvals, tools } = harness();
    let captured: FileApprovalRecord | undefined;
    const timer = setInterval(() => {
      const path = join(approvals, "apr-0001.json");
      if (!existsSync(path) || captured) return;
      captured = JSON.parse(readFileSync(path, "utf8")) as FileApprovalRecord;
      writeFileSync(
        path,
        JSON.stringify({ ...captured, decision: "approved", by: "platform" }, null, 2),
        "utf8",
      );
    }, 5);
    try {
      await runWith(new FileApprover({ dir: approvals, pollMs: 5 }), ledger, tools);
    } finally {
      clearInterval(timer);
    }
    expect(captured?.decision).toBeNull();
    expect(captured?.requestedAt).toBeTruthy();
    expect(captured?.calls).toEqual([{ toolName: "ado.case_write", args: { action: "create" } }]);
    expect(captured?.summary).toContain("ado.case_write");
  });
});
