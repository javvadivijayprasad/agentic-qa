import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  FileApprover,
  TerminalApprover,
  type FileApprovalRecord,
} from "../src/runtime/approvers.js";
import type { ApprovalRequest } from "../src/runtime/approval.js";

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
