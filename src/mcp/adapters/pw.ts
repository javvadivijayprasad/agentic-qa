import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";
import { execFileRunner, type CommandRunner } from "./process.js";

export interface PwOptions {
  runner?: CommandRunner;
  /** Command that runs Playwright. Default `npx playwright` (npx.cmd on Windows). */
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface TestRunSummary {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  /** True when the suite ran and nothing failed AND nothing was left unimplemented. */
  green: boolean;
  failures: Array<{ title: string; file: string; message: string }>;
  exitCode: number;
}

/**
 * In-process `pw` adapter: runs the workspace's Playwright suite and returns a
 * structured summary. This is the "run" in story → tests → run → Test Plans.
 *
 * Note what `green` means: a generated skeleton is `fixme`, which Playwright
 * reports as SKIPPED, so `skipped > 0` keeps `green` false. A suite that has
 * not actually been implemented can never be reported as passing.
 */
export class PwTools implements ToolClient {
  readonly server = "pw";
  private readonly fs: FsTools;
  private readonly workspace: string;
  private readonly runner: CommandRunner;
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly timeoutMs: number;

  constructor(workspaceDir: string, opts: PwOptions = {}) {
    this.fs = new FsTools(workspaceDir);
    this.workspace = workspaceDir;
    this.runner = opts.runner ?? execFileRunner;
    this.command = opts.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
    this.baseArgs = opts.args ?? ["playwright", "test"];
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const spec = {
      type: "string",
      description: "Spec file or directory, workspace-relative. Omit to run the whole suite.",
    };
    return [
      {
        server: this.server,
        name: "list_tests",
        description: "List the tests Playwright would run, without running them.",
        inputSchema: { type: "object", properties: { spec } },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "run_tests",
        description:
          "Run the Playwright suite and return { passed, failed, skipped, flaky, green, failures[] }. Skipped counts unimplemented (fixme) tests, and any skipped test keeps green false.",
        inputSchema: {
          type: "object",
          properties: {
            spec,
            grep: { type: "string", description: "Only run tests whose title matches this." },
          },
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not a pw tool: ${server}.${name}`);
    if (name !== "run_tests" && name !== "list_tests") return fail(`unknown pw tool: ${name}`);

    const extra: string[] = [];
    const spec = args["spec"];
    if (typeof spec === "string" && spec) {
      if (!this.fs.inside(spec)) return fail(`path escapes the workspace: ${spec}`);
      // On Windows the launcher goes through the command interpreter, so an
      // argument carrying shell punctuation is refused rather than escaped.
      if (SHELL_UNSAFE.test(spec)) return fail(`spec path contains unsafe characters: ${spec}`);
      extra.push(spec);
    }
    const grep = args["grep"];
    if (typeof grep === "string" && grep) {
      if (SHELL_UNSAFE.test(grep)) return fail(`grep contains unsafe characters: ${grep}`);
      extra.push("--grep", grep);
    }

    if (name === "list_tests") {
      const r = await this.runner(this.command, [...this.baseArgs, ...extra, "--list"], {
        cwd: this.workspace,
        timeoutMs: this.timeoutMs,
      });
      return {
        ok: r.code === 0,
        result: { exitCode: r.code, output: tail(r.stdout || r.stderr) },
        artefacts: [],
      };
    }

    const reportRel = join(".aqa-report", "playwright.json");
    const r = await this.runner(
      this.command,
      [...this.baseArgs, ...extra, "--reporter=json"],
      // PLAYWRIGHT_JSON_OUTPUT_NAME would need env support in the runner; the
      // reporter also writes to stdout, which is what we parse. The file is
      // read when the project is configured to produce one.
      { cwd: this.workspace, timeoutMs: this.timeoutMs },
    );
    const reportAbs = join(this.workspace, reportRel);
    const raw = r.stdout.trim().startsWith("{")
      ? r.stdout
      : existsSync(reportAbs)
        ? readFileSync(reportAbs, "utf8")
        : "";
    const summary = summarise(raw, r.code);
    if (!summary) {
      return fail(
        `Playwright produced no JSON report (exit ${r.code}). ${tail(r.stderr || r.stdout)}`,
      );
    }
    // Keep the full report, not just the summary. Per-test durations, retries
    // and error stacks are what a failure triage needs, they cannot be
    // reconstructed after the fact, and the flat summary deliberately throws
    // them away to keep the model's context small. When the reporter wrote to
    // stdout — which is the usual case — nothing had been persisting them at
    // all. Writing it as an artefact costs one file and makes the run's raw
    // evidence as durable as its conclusions.
    if (!existsSync(reportAbs) && raw) {
      try {
        mkdirSync(dirname(reportAbs), { recursive: true });
        writeFileSync(reportAbs, raw, "utf8");
      } catch {
        // A workspace we cannot write to still has a usable summary; the
        // report is evidence we would like, not evidence we require.
      }
    }
    return {
      ok: true,
      result: summary,
      artefacts: existsSync(reportAbs) ? [reportRel] : [],
    };
  }
}

/** Parse Playwright's JSON reporter output into a flat summary. */
export function summarise(raw: string, exitCode: number): TestRunSummary | undefined {
  let report: unknown;
  try {
    report = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof report !== "object" || report === null) return undefined;
  const stats = (report as { stats?: Record<string, unknown> }).stats ?? {};
  const num = (k: string): number => (typeof stats[k] === "number" ? (stats[k] as number) : 0);
  const failures: TestRunSummary["failures"] = [];
  walkSuites((report as { suites?: unknown[] }).suites ?? [], "", failures);
  const passed = num("expected");
  const failed = num("unexpected") || failures.length;
  const skipped = num("skipped");
  const flaky = num("flaky");
  return {
    passed,
    failed,
    skipped,
    flaky,
    green: exitCode === 0 && failed === 0 && skipped === 0 && flaky === 0 && passed > 0,
    failures,
    exitCode,
  };
}

function walkSuites(suites: unknown[], file: string, out: TestRunSummary["failures"]): void {
  for (const s of suites) {
    if (typeof s !== "object" || s === null) continue;
    const suite = s as {
      file?: string;
      suites?: unknown[];
      specs?: Array<{ title?: string; ok?: boolean; tests?: Array<{ results?: unknown[] }> }>;
    };
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      if (spec.ok !== false) continue;
      out.push({ title: spec.title ?? "(untitled)", file: f, message: firstError(spec) });
    }
    if (suite.suites) walkSuites(suite.suites, f, out);
  }
}

function firstError(spec: { tests?: Array<{ results?: unknown[] }> }): string {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      const err = (r as { error?: { message?: string } }).error;
      if (err?.message) return tail(err.message, 400);
    }
  }
  return "";
}

/** Characters that mean something to a command interpreter. */
const SHELL_UNSAFE = /[&|<>^"'`$;%\r\n]/;

function tail(s: string, max = 2000): string {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(-max)}`;
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
