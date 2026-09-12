import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLedgerFile, main, discover, run, type CliIo } from "../src/cli.js";
import { StubTools } from "../src/runtime/tools.js";

const FIXTURE_DIR = join(process.cwd(), "examples", "fixture-ledger");
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
    expect(buf.out).toMatch(/0\.1\.0/);
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
    expect(buf.out).toMatch(/2 tools from .* 1 unclassified/);
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
    expect(buf.out).toContain("ado.wit_get_work_item: read → execute (scope args required)");
    expect(buf.out).toContain("ado.mystery: destructive → refuse");
    expect(buf.out).toContain("no model or tool calls were made");
    expect(ft.isClosed()).toBe(true);
  });

  it("without --dry-run says the model adapter is not there yet", async () => {
    const dir = tmp();
    const cfg = join(dir, "c.json");
    writeFileSync(cfg, JSON.stringify({ agent: { scope: {} } }));
    const { cli, buf } = io();
    expect(await run(["x", "--config", cfg], cli)).toBe(1);
    expect(buf.err).toMatch(/only --dry-run/);
  });

  it("requires --config and a request", async () => {
    const { cli } = io();
    expect(await run(["--dry-run"], cli)).toBe(1);
    expect(await run(["x", "--dry-run"], cli)).toBe(1);
  });
});
