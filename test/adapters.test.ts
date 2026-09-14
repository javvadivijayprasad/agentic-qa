import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bdd2PwTools, parseFeature, renderSpec } from "../src/mcp/adapters/bdd2pw.js";
import { PwTools, summarise } from "../src/mcp/adapters/pw.js";
import { TcgTools, type FetchLike } from "../src/mcp/adapters/tcg.js";
import { SynthdataTools } from "../src/mcp/adapters/synthdata.js";
import { splitCommand, spawnable, type CommandRunner } from "../src/mcp/adapters/process.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-ad-"));

const FEATURE = `# login flows
@auth
Feature: Login with valid credentials

  Background:
    Given the application is running

  Scenario: AC-1 valid credentials reach the dashboard
    Given the user is on the login page
    When they submit valid credentials
    Then the dashboard is shown

  Scenario Outline: AC-2 invalid credentials are rejected
    When they submit "<user>" and "<password>"
    Then the error "<message>" is shown

    Examples:
      | user  | password | message           |
      | alice | wrong    | Invalid password  |
      |       | secret   | Username required |
`;

describe("bdd2pw parse", () => {
  it("reads feature, background, scenarios and expands Scenario Outline rows", () => {
    const f = parseFeature(FEATURE);
    expect(f.feature).toBe("Login with valid credentials");
    expect(f.background).toEqual([{ keyword: "Given", text: "the application is running" }]);
    expect(f.scenarios).toHaveLength(3);
    expect(f.scenarios[0]!.tags).toEqual(["@auth"]);
    expect(f.scenarios[0]!.steps.map((s) => s.keyword)).toEqual(["Given", "When", "Then"]);
    // one test per Examples row, placeholders substituted
    expect(f.scenarios[1]!.steps[0]!.text).toBe('they submit "alice" and "wrong"');
    expect(f.scenarios[2]!.steps[1]!.text).toBe('the error "Username required" is shown');
  });

  it("survives an empty or comment-only feature file", () => {
    expect(parseFeature("# nothing here\n").scenarios).toEqual([]);
    expect(renderSpec(parseFeature(""), "x.feature")).toContain("no scenarios found");
  });
});

describe("bdd2pw to_spec", () => {
  it("writes a spec whose tests are fixme, with one test.step per Gherkin step", async () => {
    const ws = tmp();
    mkdirSync(join(ws, "features"));
    writeFileSync(join(ws, "features", "login.feature"), FEATURE);
    const t = new Bdd2PwTools(ws);
    const r = await t.call("bdd2pw", "to_spec", { path: "features/login.feature" });
    expect(r.ok).toBe(true);
    expect(r.artefacts).toEqual(["tests/login.spec.ts"]);
    expect(r.result).toMatchObject({ tests: 3, unimplemented: 3 });
    const spec = readFileSync(join(ws, "tests", "login.spec.ts"), "utf8");
    expect(spec).toContain('test.describe("Login with valid credentials"');
    expect(spec).toContain("test.fixme(true,");
    // background step is prepended to every test
    expect(spec.match(/Given the application is running/g)).toHaveLength(3);
    expect(spec).toContain('await test.step("When they submit valid credentials"');
  });

  it("honours --out, refuses escapes and missing files", async () => {
    const ws = tmp();
    writeFileSync(join(ws, "a.feature"), "Feature: A\n  Scenario: s\n    Given x\n");
    const t = new Bdd2PwTools(ws);
    const r = await t.call("bdd2pw", "to_spec", { path: "a.feature", out: "e2e/a.spec.ts" });
    expect(r.artefacts).toEqual(["e2e/a.spec.ts"]);
    expect((await t.call("bdd2pw", "to_spec", { path: "../x.feature" })).ok).toBe(false);
    expect((await t.call("bdd2pw", "parse", { path: "nope.feature" })).ok).toBe(false);
    expect((await t.call("bdd2pw", "to_spec", { path: "a.feature", out: "../x" })).ok).toBe(false);
  });
});

describe("pw run_tests", () => {
  const report = (stats: Record<string, number>, suites: unknown[] = []) =>
    JSON.stringify({ stats, suites });

  function runner(result: { code: number; stdout: string; stderr?: string }): {
    fn: CommandRunner;
    seen: string[][];
  } {
    const seen: string[][] = [];
    const fn: CommandRunner = async (command, args) => (
      seen.push([command, ...args]),
      { code: result.code, stdout: result.stdout, stderr: result.stderr ?? "" }
    );
    return { fn, seen };
  }

  it("passes spec and grep through and reports a green run", async () => {
    const r = runner({ code: 0, stdout: report({ expected: 4, unexpected: 0, skipped: 0 }) });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", { spec: "tests/login.spec.ts", grep: "AC-1" });
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ passed: 4, failed: 0, green: true });
    expect(r.seen[0]).toContain("tests/login.spec.ts");
    expect(r.seen[0]).toContain("--grep");
    expect(r.seen[0]).toContain("--reporter=json");
  });

  it("is NOT green when tests are skipped — an unimplemented skeleton never passes", async () => {
    const r = runner({ code: 0, stdout: report({ expected: 0, unexpected: 0, skipped: 3 }) });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", {});
    expect(out.result).toMatchObject({ skipped: 3, green: false });
  });

  it("collects failing test titles and messages", async () => {
    const suites = [
      {
        file: "tests/login.spec.ts",
        specs: [
          { title: "AC-1", ok: false, tests: [{ results: [{ error: { message: "boom" } }] }] },
          { title: "AC-2", ok: true },
        ],
        suites: [{ specs: [{ title: "nested", ok: false, tests: [] }] }],
      },
    ];
    const r = runner({ code: 1, stdout: report({ expected: 1, unexpected: 2 }, suites) });
    const out = await new PwTools(tmp(), { runner: r.fn }).call("pw", "run_tests", {});
    expect(out.result).toMatchObject({ failed: 2, green: false, exitCode: 1 });
    expect((out.result as { failures: unknown[] }).failures).toEqual([
      { title: "AC-1", file: "tests/login.spec.ts", message: "boom" },
      { title: "nested", file: "tests/login.spec.ts", message: "" },
    ]);
  });

  it("fails loudly when Playwright produced no JSON, and refuses escaping specs", async () => {
    const r = runner({ code: 127, stdout: "", stderr: "playwright: not found" });
    const pw = new PwTools(tmp(), { runner: r.fn });
    const out = await pw.call("pw", "run_tests", {});
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out.result)).toContain("not found");
    expect((await pw.call("pw", "run_tests", { spec: "../evil" })).ok).toBe(false);
    expect((await pw.call("pw", "nope", {})).ok).toBe(false);
  });

  it("summarise rejects non-JSON", () => {
    expect(summarise("not json", 0)).toBeUndefined();
    expect(summarise("null", 0)).toBeUndefined();
  });
});

describe("tcg generate_cases", () => {
  const ok =
    (body: unknown): FetchLike =>
    async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    });

  it("posts the story and unwraps { cases } or a bare array", async () => {
    let sent: unknown;
    const fetchImpl: FetchLike = async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ cases: [{ title: "a" }] }),
      };
    };
    const t = new TcgTools("https://tcg.example/generate", { fetch: fetchImpl });
    const r = await t.call("tcg", "generate_cases", {
      story: "Login",
      acceptanceCriteria: ["AC-1"],
      count: 5,
    });
    expect(r.result).toEqual({ cases: [{ title: "a" }], count: 1 });
    expect(sent).toEqual({
      url: "https://tcg.example/generate",
      body: { story: "Login", acceptanceCriteria: ["AC-1"], count: 5 },
    });
    const bare = new TcgTools("u", { fetch: ok([{ title: "b" }]) });
    expect((await bare.call("tcg", "generate_cases", { story: "s" })).result).toMatchObject({
      count: 1,
    });
  });

  it("turns HTTP errors, bad JSON and missing cases into ok:false", async () => {
    const bad = (f: FetchLike) => new TcgTools("u", { fetch: f });
    const http: FetchLike = async () => ({ ok: false, status: 503, text: async () => "down" });
    const notJson: FetchLike = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    expect((await bad(http).call("tcg", "generate_cases", { story: "s" })).ok).toBe(false);
    expect((await bad(notJson).call("tcg", "generate_cases", { story: "s" })).ok).toBe(false);
    expect((await bad(ok({ nope: 1 })).call("tcg", "generate_cases", { story: "s" })).ok).toBe(
      false,
    );
    expect((await bad(ok({})).call("tcg", "generate_cases", {})).ok).toBe(false);
  });
});

describe("synthdata generate", () => {
  it("builds the command line, keeps output in the workspace and reports bytes", async () => {
    const ws = tmp();
    const seen: string[][] = [];
    const runner: CommandRunner = async (command, args, opts) => {
      seen.push([command, ...args]);
      writeFileSync(join(opts.cwd, "data/users.json".split("/").join("/")), "[]");
      return { code: 0, stdout: "wrote 3", stderr: "" };
    };
    mkdirSync(join(ws, "data"));
    const t = new SynthdataTools("python tools/synth.py", ws, { runner });
    const r = await t.call("synthdata", "generate", {
      schema: "users",
      count: 3,
      out: "data/users.json",
    });
    expect(r.ok).toBe(true);
    expect(r.artefacts).toEqual(["data/users.json"]);
    expect(seen[0]).toEqual([
      "python",
      "tools/synth.py",
      "--schema",
      "users",
      "--count",
      "3",
      "--out",
      "data/users.json",
    ]);
  });

  it("refuses escapes, bad counts and non-zero exits", async () => {
    const ws = tmp();
    const fine: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });
    const boom: CommandRunner = async () => ({ code: 2, stdout: "", stderr: "schema unknown" });
    const t = (r: CommandRunner) => new SynthdataTools("gen", ws, { runner: r });
    expect((await t(fine).call("synthdata", "generate", { schema: "u", out: "../x" })).ok).toBe(
      false,
    );
    expect(
      (await t(fine).call("synthdata", "generate", { schema: "u", out: "a", count: 0 })).ok,
    ).toBe(false);
    expect((await t(fine).call("synthdata", "generate", { out: "a" })).ok).toBe(false);
    const failed = await t(boom).call("synthdata", "generate", { schema: "u", out: "a" });
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed.result)).toContain("schema unknown");
  });
});

describe("splitCommand", () => {
  it("splits on whitespace and keeps quoted segments together", () => {
    expect(splitCommand("python tools/synth.py")).toEqual({
      command: "python",
      args: ["tools/synth.py"],
    });
    expect(splitCommand('"C:/Program Files/py.exe" -m gen')).toEqual({
      command: "C:/Program Files/py.exe",
      args: ["-m", "gen"],
    });
    expect(splitCommand("   ")).toBeUndefined();
  });
});

describe("spawnable (Windows batch launchers)", () => {
  it("routes a .cmd through the command interpreter, arguments still as an array", () => {
    const saved = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      // Node refuses to spawn .cmd directly since the batch-injection fix, and
      // returns EINVAL — which is exactly how a real run failed.
      const s = spawnable("npx.cmd", ["playwright", "test", "--reporter=json"]);
      expect(s.command.toLowerCase()).toContain("cmd");
      expect(s.args.slice(0, 4)).toEqual(["/d", "/s", "/c", "npx.cmd"]);
      expect(s.args).toContain("--reporter=json");
      // a plain executable is untouched
      expect(spawnable("node", ["x.js"])).toEqual({ command: "node", args: ["x.js"] });
    } finally {
      Object.defineProperty(process, "platform", saved);
    }
  });

  it("leaves everything alone off Windows", () => {
    expect(spawnable("npx", ["playwright"])).toEqual({ command: "npx", args: ["playwright"] });
  });
});

describe("pw: unsafe arguments", () => {
  it("refuses shell punctuation in spec and grep rather than escaping it", async () => {
    const pw = new PwTools(tmp(), {
      runner: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    });
    expect((await pw.call("pw", "run_tests", { spec: "tests/a.spec.ts & calc" })).ok).toBe(false);
    expect((await pw.call("pw", "run_tests", { grep: 'AC-1" & del *' })).ok).toBe(false);
  });
});
