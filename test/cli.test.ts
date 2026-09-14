import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLedgerFile, main, discover, run, VERSION, type CliIo } from "../src/cli.js";
import { StubTools } from "../src/runtime/tools.js";
import { ScriptedModel } from "../src/runtime/model.js";

const FIXTURE_DIR = join(process.cwd(), "examples", "fixture-ledger");
const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  version: string;
};
const tmp = () => mkdtempSync(join(tmpdir(), "aqa-cli-"));

function io() {
  const buf = { out: "", err: "" };
  const cli: CliIo = { out: (s) => void (buf.out += s), err: (s) => void (buf.err += s) };
  return { cli, buf };
}

describe("resolveLedgerFile", () => {
  it("accepts a directory containing events.jsonl", () => {
    expect(resolveLedgerFile(FIXTURE_DIR)).toBe(join(FIXTURE_DIR, "events.jsonl"));
  });
  it("accepts the jsonl file itself", () => {
    const f = join(FIXTURE_DIR, "events.jsonl");
    expect(resolveLedgerFile(f)).toBe(f);
  });
  it("picks the latest run under <root>/runs", () => {
    const root = tmp();
    for (const r of ["20260101T000000Z-a", "20260102T000000Z-b"]) {
      mkdirSync(join(root, "runs", r), { recursive: true });
      writeFileSync(join(root, "runs", r, "events.jsonl"), "");
    }
    expect(resolveLedgerFile(root)).toBe(join(root, "runs", "20260102T000000Z-b", "events.jsonl"));
  });
  it("returns undefined when nothing is there", () => {
    expect(resolveLedgerFile(join(tmpdir(), "definitely-missing-aqa"))).toBeUndefined();
  });
});

describe("aqa replay", () => {
  it("writes a markdown report with --out and exits 0", async () => {
    const out = join(tmp(), "report.md");
    const { cli } = io();
    expect(await main(["replay", FIXTURE_DIR, "--out", out], cli)).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("# agentic-qa replay");
  });
  it("exits 1 for a missing path", async () => {
    const { cli } = io();
    expect(await main(["replay", join(tmpdir(), "nope-aqa")], cli)).toBe(1);
  });
  it("--help and --version", async () => {
    const { cli, buf } = io();
    expect(await main(["--help"], cli)).toBe(0);
    expect(buf.out).toContain("aqa discover");
    expect(await main(["--version"], cli)).toBe(0);
    expect(buf.out).toContain(`${pkg.version}\n`);
  });
  it("--version is exactly the published version, not a loose match", () => {
    // A substring assertion let "0.1.0-dev.0" pass as "0.1.0" through a whole
    // release. What a user reports must name a commit exactly.
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).not.toMatch(/dev|0\.0\.0/);
  });
});

function fakeTooling() {
  const tools = new StubTools()
    .add(
      {
        server: "ado",
        name: "wit_get_work_item",
        description: "Get",
        inputSchema: { type: "object" },
        policyClass: "read",
        scopeArgs: { workItem: "id" },
      },
      { ok: true, result: {}, artefacts: [] },
    )
    .add(
      {
        server: "ado",
        name: "mystery",
        description: "",
        inputSchema: {},
        policyClass: "destructive",
      },
      { ok: true, result: {}, artefacts: [] },
    )
    .add(
      {
        server: "ado",
        name: "testplan",
        description: "Multiplexed",
        inputSchema: { type: "object" },
        policyClass: "write_record",
        actionArg: "action",
        actions: {
          list_plans: { policyClass: "read" },
          create: { policyClass: "write_record", scopeArgs: { testPlan: "name" } },
        },
      },
      { ok: true, result: {}, artefacts: [] },
    );
  let closed = false;
  return {
    deps: { buildTools: async () => ({ tools, close: async () => void (closed = true) }) },
    isClosed: () => closed,
  };
}

describe("aqa discover", () => {
  it("writes tools-observed.md + .json, lists tools, flags unclassified, closes servers", async () => {
    const dir = tmp();
    const out = join(dir, "docs", "tools-observed.md");
    const { cli, buf } = io();
    const ft = fakeTooling();
    const code = await discover(
      ["--servers", "fs", "--out", out, "--env", join(dir, "no.env")],
      cli,
      ft.deps,
    );
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(out.replace(/\.md$/, ".json"))).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("`ado.mystery` | destructive | **no**");
    expect(buf.out).toMatch(/3 tools from .* 1 unclassified/);
    expect(buf.out).toContain("! ado.mystery");
    expect(ft.isClosed()).toBe(true);
  });

  it("refuses --servers ado without Azure DevOps env, with a config error", async () => {
    const dir = tmp();
    const { cli, buf } = io();
    const saved = { ...process.env };
    delete process.env["AZURE_DEVOPS_ORG_URL"];
    try {
      const code = await main(["discover", "--servers", "ado", "--env", join(dir, "no.env")], cli);
      expect(code).toBe(1);
      expect(buf.err).toMatch(/config error: --servers includes ado/);
    } finally {
      process.env = saved;
    }
  });
});

describe("aqa run --dry-run", () => {
  it("loads config, lists tools with class → decision, makes no calls", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        agent: {
          scope: { work_items: ["1"], repos: [], test_plans: [], branches_writable: [] },
          policy: { read: "execute" },
        },
      }),
    );
    const { cli, buf } = io();
    const ft = fakeTooling();
    const code = await run(
      [
        "Write tests for AB#1",
        "--config",
        cfg,
        "--dry-run",
        "--servers",
        "fs",
        "--env",
        join(dir, "no.env"),
      ],
      cli,
      ft.deps,
    );
    expect(code).toBe(0);
    expect(buf.out).toContain('aqa run --dry-run: "Write tests for AB#1"');
    expect(buf.out).toContain("ado.wit_get_work_item: read → execute");
    expect(buf.out).toMatch(/argument "id" \(work item\) is required for scope checks/);
    expect(buf.out).toContain("ado.mystery: destructive → refuse");
    // an action-multiplexed tool is shown per action, worst case first
    expect(buf.out).toContain("ado.testplan: write_record → ask");
    expect(buf.out).toContain("action=list_plans: read → execute");
    expect(buf.out).toContain("action=create: write_record → ask");
    expect(buf.out).toContain("no model or tool calls were made");
    expect(ft.isClosed()).toBe(true);
  });

  it("without --dry-run, refuses a request with no work item reference", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ agent: { scope: { work_items: ["1"] } } }));
    const { cli, buf } = io();
    expect(await run(["do some testing", "--config", cfg, "--env", join(dir, "no.env")], cli)).toBe(
      1,
    );
    expect(buf.err).toMatch(/no work item in the request/);
  });

  it("without --dry-run, refuses (exit 3) a work item outside scope before spending a token", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ agent: { scope: { work_items: ["1"] } } }));
    const { cli, buf } = io();
    const code = await run(
      ["Write tests for AB#99", "--config", cfg, "--env", join(dir, "no.env")],
      cli,
    );
    expect(code).toBe(3);
    expect(buf.err).toMatch(/work item 99 is not in agent.scope.work_items/);
  });

  it("requires --config and a request", async () => {
    const { cli } = io();
    expect(await run(["--dry-run"], cli)).toBe(1);
    expect(await run(["x", "--dry-run"], cli)).toBe(1);
  });
});

describe("aqa run (live path, scripted model)", () => {
  it("runs the loop end to end: ledger written, verifier decides, exit code reflects it", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        agent: {
          scope: { work_items: ["1"], repos: [], test_plans: [], branches_writable: [] },
          budgets: { steps: 8, tokens: 10000 },
        },
      }),
    );
    const tools = new StubTools().add(
      {
        server: "ado",
        name: "wit_work_item",
        description: "Work items",
        inputSchema: { type: "object" },
        policyClass: "read",
        actionArg: "action",
        actions: { get: { policyClass: "read", scopeArgs: { workItem: "id" } } },
      },
      { ok: true, result: { id: 1, title: "Login" }, artefacts: [] },
    );
    const usage = { inputTokens: 10, outputTokens: 5 };
    const model = new ScriptedModel({
      plan: { steps: ["read the story"], usage },
      decisions: [
        { calls: [{ toolName: "ado.wit_work_item", args: { action: "get", id: "1" } }], usage },
        { calls: [], note: "done as far as I can get", usage },
        { calls: [], note: "still nothing more to do", usage },
      ],
    });
    const { cli, buf } = io();
    const code = await run(
      [
        "Write tests for AB#1",
        "--config",
        cfg,
        "--ledger",
        join(dir, ".aqa"),
        "--servers",
        "fs",
        "--env",
        join(dir, "no.env"),
      ],
      cli,
      {
        buildTools: async () => ({ tools, close: async () => {} }),
        buildModel: () => model,
      },
    );

    // The story was read but nothing else was: the verifier refuses to call it done.
    expect(code).toBe(2);
    expect(buf.out).toContain("blocked:");
    expect(buf.out).toMatch(/replay: aqa replay/);

    const runs = readdirSync(join(dir, ".aqa", "runs"));
    expect(runs).toHaveLength(1);
    const events = readFileSync(join(dir, ".aqa", "runs", runs[0]!, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
    expect(events[0]!.kind).toBe("request");
    expect(events.at(-1)!.kind).toBe("end");
    expect(events.some((e) => e.kind === "call")).toBe(true);
    const verify = events.filter((e) => e.kind === "verify");
    expect(verify.length).toBeGreaterThan(0);
    expect((verify[0]!.payload as { done: boolean }).done).toBe(false);
    // the model's claim of being finished is recorded, but did not decide the outcome
    expect(JSON.stringify(events)).toContain("done as far as I can get");
  });
});

describe("aqa run: credential provenance", () => {
  it("says which file the key came from, or that the shell shadowed it", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ agent: { scope: { work_items: ["1"] } } }));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "ANTHROPIC_API_KEY=sk-ant-from-the-file\n");
    const saved = process.env["ANTHROPIC_API_KEY"];

    // 1. nothing in the shell: the file is used and named
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const a = io();
      await run(["Write tests for AB#99", "--config", cfg, "--env", envFile], a.cli);
      expect(a.buf.err).toContain("1 key(s) loaded");
      expect(a.buf.err).toContain(`from ${envFile}`);
      expect(a.buf.err).toContain("sk-a…");
      expect(a.buf.err).not.toContain("from-the-file");

      // 2. a stale key in the shell wins, and the run says so
      process.env["ANTHROPIC_API_KEY"] = "sk-ant-stale-shell-key";
      const b = io();
      await run(["Write tests for AB#99", "--config", cfg, "--env", envFile], b.cli);
      expect(b.buf.err).toMatch(/from the shell environment \(NOT .*\.env\)/);
    } finally {
      if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
      else process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });
});

describe("--approval-timeout", () => {
  it("rejects a value that is not a positive number of seconds", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ agent: { scope: { work_items: ["1"] } } }));
    for (const bad of ["0", "-5", "soon"]) {
      const { cli, buf } = io();
      const code = await run(
        [
          "Write tests for AB#1",
          "--config",
          cfg,
          "--env",
          join(dir, "no.env"),
          "--approval",
          "file",
          "--approval-timeout",
          bad,
        ],
        cli,
      );
      expect(code).toBe(1);
      expect(buf.err).toMatch(/positive number of seconds/);
    }
  });
});
