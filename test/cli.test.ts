import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLedgerFile, main } from "../src/cli.js";

const FIXTURE_DIR = join(process.cwd(), "examples", "fixture-ledger");

describe("resolveLedgerFile", () => {
  it("accepts a directory containing events.jsonl", () => {
    expect(resolveLedgerFile(FIXTURE_DIR)).toBe(join(FIXTURE_DIR, "events.jsonl"));
  });
  it("accepts the jsonl file itself", () => {
    const f = join(FIXTURE_DIR, "events.jsonl");
    expect(resolveLedgerFile(f)).toBe(f);
  });
  it("picks the latest run under <root>/runs", () => {
    const root = mkdtempSync(join(tmpdir(), "aqa-cli-"));
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
    const out = join(mkdtempSync(join(tmpdir(), "aqa-cli-out-")), "report.md");
    const code = await main(["replay", FIXTURE_DIR, "--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("# agentic-qa replay");
  });
  it("exits 1 for a missing path", async () => {
    expect(await main(["replay", join(tmpdir(), "nope-aqa")])).toBe(1);
  });
  it("run is not implemented yet and says so", async () => {
    expect(await main(["run", "x"])).toBe(1);
  });
});
