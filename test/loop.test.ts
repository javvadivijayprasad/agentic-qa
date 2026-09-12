import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, LEDGER_FILE, runDir } from "../src/ledger/ledger.js";
import { TableGate } from "../src/governance/policy.js";
import { ScriptedApprover } from "../src/runtime/approval.js";
import { SteppingClock } from "../src/runtime/clock.js";
import { runLoop, type LoopDeps } from "../src/runtime/loop.js";
import { ScriptedModel, type ModelDecision } from "../src/runtime/model.js";
import { StubTools } from "../src/runtime/tools.js";
import { ScriptedVerifier } from "../src/verify/scripted.js";
import type { AgentConfig, Skill, AnyRunEvent } from "../src/types.js";
import { DEFAULT_POLICY } from "../src/types.js";
import {
  FIXTURE_RUN_ID,
  fixtureConfig,
  fixtureModel,
  fixtureSkill,
  fixtureTools,
  runFixtureScenario,
} from "../examples/fixture-ledger/scenario.js";

const FIXTURE = join(process.cwd(), "examples", "fixture-ledger", "events.jsonl");
const tmp = () => mkdtempSync(join(tmpdir(), "aqa-loop-"));
const u = { inputTokens: 100, outputTokens: 10 };
const kinds = (events: AnyRunEvent[]) => events.map((e) => e.kind);

function tools(): StubTools {
  return new StubTools()
    .add(
      { server: "s", name: "read", description: "", inputSchema: {}, policyClass: "read" },
      { ok: true, result: { v: 1 }, artefacts: [] },
    )
    .add(
      { server: "s", name: "write", description: "", inputSchema: {}, policyClass: "write_record" },
      { ok: true, result: { saved: true }, artefacts: [] },
    )
    .add(
      { server: "s", name: "boom", description: "", inputSchema: {}, policyClass: "read" },
      () => {
        throw new Error("tool exploded");
      },
    );
}

function skill(verifier = new ScriptedVerifier([{ done: true, gaps: [] }])): Skill {
  return {
    name: "t",
    instructions: "test skill",
    allowedTools: ["s.read", "s.write", "s.boom"],
    verifier,
  };
}

function config(over: Partial<AgentConfig["budgets"]> = {}): AgentConfig {
  return {
    ...fixtureConfig,
    budgets: { steps: 10, tokens: 100000, ...over },
    policy: DEFAULT_POLICY,
  };
}

function deps(
  decisions: ModelDecision[],
  over: Partial<LoopDeps> = {},
): LoopDeps & { ledger: Ledger } {
  const ledger = new Ledger(tmp(), "run-t");
  return {
    requestText: "do the thing",
    model: new ScriptedModel({ plan: { steps: ["a"], usage: u }, decisions }),
    tools: tools(),
    gate: new TableGate(),
    approver: new ScriptedApprover([], {
      decision: "approved",
      by: "tester",
      at: "2026-01-01T00:00:00Z",
    }),
    skill: skill(),
    ledger,
    config: config(),
    workspaceDir: "/tmp/ws",
    clock: new SteppingClock(1_000_000, 10),
    ...over,
  };
}

const goal: ModelDecision = { calls: [], usage: u };
const read: ModelDecision = { calls: [{ toolName: "s.read", args: {} }], usage: u };

describe("golden: the loop reproduces the checked-in fixture exactly", () => {
  it("byte-for-byte", async () => {
    const root = tmp();
    const result = await runFixtureScenario(root);
    expect(result.status).toBe("done");
    expect(result.exitCode).toBe(0);
    const produced = readFileSync(join(runDir(root, FIXTURE_RUN_ID), LEDGER_FILE), "utf8");
    const golden = readFileSync(FIXTURE, "utf8");
    expect(produced).toBe(golden);
  });

  it("the fixture scenario only exposes the skill's allowed tools to the model", async () => {
    const model = fixtureModel();
    const ledger = new Ledger(tmp(), "run-x");
    await runLoop({
      requestText: "r",
      model,
      tools: fixtureTools(),
      gate: new TableGate(),
      approver: new ScriptedApprover([], { decision: "approved", by: "t", at: "" }),
      skill: fixtureSkill(),
      ledger,
      config: fixtureConfig,
      workspaceDir: "/tmp",
      clock: new SteppingClock(1, 1),
    });
    const seen = model.inputs[0]!.tools.map((t) => `${t.server}.${t.name}`).sort();
    expect(seen).toEqual([...fixtureSkill().allowedTools].sort());
  });
});

describe("stop rules", () => {
  it("done: goal reached and verifier passes → exit 0, end event, summary.md written", async () => {
    const d = deps([read, goal]);
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    expect(r.exitCode).toBe(0);
    const ev = d.ledger.read();
    expect(kinds(ev)).toEqual([
      "request",
      "plan",
      "context",
      "inference",
      "policy",
      "call",
      "observation",
      "context",
      "inference",
      "verify",
      "end",
    ]);
    expect(readFileSync(join(d.ledger.dir, "summary.md"), "utf8")).toContain("# agentic-qa replay");
  });

  it("budget: step budget exhausted → exit 4", async () => {
    const d = deps(Array(10).fill(read), { config: config({ steps: 3 }) });
    const r = await runLoop(d);
    expect(r.status).toBe("budget");
    expect(r.exitCode).toBe(4);
    expect(d.ledger.read().filter((e) => e.kind === "call")).toHaveLength(3);
    expect(r.summary).toMatch(/step budget of 3/);
  });

  it("budget: token budget exhausted → exit 4", async () => {
    const d = deps(Array(10).fill(read), { config: config({ tokens: 250 }) });
    const r = await runLoop(d);
    expect(r.status).toBe("budget");
    expect(r.summary).toMatch(/token budget/);
  });

  it("blocked: verifier gaps → one retry with gaps in context → still gaps → exit 2", async () => {
    const verifier = new ScriptedVerifier([
      { done: false, gaps: [{ code: "AC_UNCOVERED", message: "AC-3 has no scenario" }] },
      { done: false, gaps: [{ code: "AC_UNCOVERED", message: "AC-3 has no scenario" }] },
    ]);
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [goal, read, goal],
    });
    const d = deps([], { model, skill: skill(verifier) });
    const r = await runLoop(d);
    expect(r.status).toBe("blocked");
    expect(r.exitCode).toBe(2);
    // The model saw the gaps on the retry cycle.
    expect(model.inputs[1]!.gaps).toEqual(["AC_UNCOVERED: AC-3 has no scenario"]);
    expect(d.ledger.read().filter((e) => e.kind === "verify")).toHaveLength(2);
  });

  it("done after retry: gaps closed on the second verify", async () => {
    const verifier = new ScriptedVerifier([
      { done: false, gaps: [{ code: "X", message: "m" }] },
      { done: true, gaps: [] },
    ]);
    const d = deps([goal, read, goal], { skill: skill(verifier) });
    expect((await runLoop(d)).status).toBe("done");
  });

  it("blocked: approval denied and nothing else in the cycle → exit 2", async () => {
    const d = deps([{ calls: [{ toolName: "s.write", args: { x: 1 } }], usage: u }], {
      approver: new ScriptedApprover([{ decision: "denied", by: "reviewer", at: "t" }]),
    });
    const r = await runLoop(d);
    expect(r.status).toBe("blocked");
    expect(r.summary).toMatch(/apr-0001 denied/);
    const ev = d.ledger.read();
    expect(ev.filter((e) => e.kind === "call")).toHaveLength(0);
    expect(kinds(ev)).toContain("approval_requested");
    expect(kinds(ev)).toContain("approval_resolved");
  });

  it("error: the model throws → exit 1 with the message", async () => {
    const d = deps([]); // ScriptedModel throws when asked beyond its script
    const r = await runLoop(d);
    expect(r.status).toBe("error");
    expect(r.exitCode).toBe(1);
    expect(r.summary).toMatch(/no decision scripted/);
    expect(d.ledger.read().at(-1)!.kind).toBe("end");
  });
});

describe("gate feedback", () => {
  it("a refused (unknown) tool is never called and the model sees the refusal next cycle", async () => {
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [{ calls: [{ toolName: "s.delete_everything", args: {} }], usage: u }, goal],
    });
    const d = deps([], { model });
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    const ev = d.ledger.read();
    const policy = ev.find((e) => e.kind === "policy")!;
    expect(policy.kind === "policy" && policy.payload.decision).toBe("refuse");
    expect(policy.kind === "policy" && policy.payload.class).toBe("destructive");
    expect(ev.filter((e) => e.kind === "call")).toHaveLength(0);
    expect((d.tools as StubTools).calls).toHaveLength(0);
    const seen = model.inputs[1]!.history[0]!;
    expect(seen.gate?.decision).toBe("refuse");
    expect(seen.ok).toBe(false);
  });

  it("a tool not in the skill's allow-list is invisible and refused even if the client has it", async () => {
    const model = new ScriptedModel({
      plan: { steps: [], usage: u },
      decisions: [{ calls: [{ toolName: "s.write", args: {} }], usage: u }, goal],
    });
    const d = deps([], { model, skill: { ...skill(), allowedTools: ["s.read"] } });
    await runLoop(d);
    const policy = d.ledger.read().find((e) => e.kind === "policy")!;
    expect(policy.kind === "policy" && policy.payload.decision).toBe("refuse");
    expect(model.inputs[0]!.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("a tool that throws becomes a failed observation, not a crashed run", async () => {
    const d = deps([{ calls: [{ toolName: "s.boom", args: {} }], usage: u }, goal]);
    const r = await runLoop(d);
    expect(r.status).toBe("done");
    const obs = d.ledger.read().find((e) => e.kind === "observation")!;
    expect(obs.kind === "observation" && obs.payload.ok).toBe(false);
    expect(obs.kind === "observation" && JSON.stringify(obs.payload.result)).toContain(
      "tool exploded",
    );
  });

  it("one approval batches every ask in a cycle and executes them in order once approved", async () => {
    const approver = new ScriptedApprover([{ decision: "approved", by: "lead", at: "t" }]);
    const d = deps(
      [
        {
          calls: [
            { toolName: "s.read", args: {} },
            { toolName: "s.write", args: { a: 1 } },
            { toolName: "s.write", args: { a: 2 } },
          ],
          usage: u,
        },
        goal,
      ],
      { approver },
    );
    await runLoop(d);
    expect(approver.asked).toHaveLength(1);
    expect(approver.asked[0]!.calls).toHaveLength(2);
    expect(approver.asked[0]!.approvalId).toBe("apr-0001");
    const calls = (d.tools as StubTools).calls.map((c) => c.args);
    expect(calls).toEqual([{}, { a: 1 }, { a: 2 }]);
    const policies = d.ledger.read().filter((e) => e.kind === "policy");
    expect(policies).toHaveLength(3);
    expect(
      policies.filter((p) => p.kind === "policy" && p.payload.approvalId === "apr-0001"),
    ).toHaveLength(2);
  });

  it("ledger context events carry hashes and counts only, never content", async () => {
    const d = deps([read, goal], { requestText: "SECRET-REQUEST-TEXT" });
    await runLoop(d);
    const ctx = d.ledger.read().filter((e) => e.kind === "context");
    expect(ctx.length).toBeGreaterThan(0);
    for (const c of ctx) expect(JSON.stringify(c.payload)).not.toContain("SECRET-REQUEST-TEXT");
  });
});
