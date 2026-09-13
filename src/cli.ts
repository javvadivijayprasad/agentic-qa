import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLedgerFile, LEDGER_FILE } from "./ledger/ledger.js";
import { renderMarkdown } from "./ledger/replay.js";
import {
  ConfigError,
  loadAgentConfig,
  loadDotEnv,
  readRuntimeEnv,
  type RuntimeEnv,
} from "./config.js";
import { Ledger, newRunId, APPROVALS_DIR } from "./ledger/ledger.js";
import { runLoop } from "./runtime/loop.js";
import { AnthropicModel } from "./runtime/anthropic.js";
import { TerminalApprover, FileApprover } from "./runtime/approvers.js";
import { storyToTestsSkill } from "./skills/story-to-tests.js";
import { parseWorkItemRef } from "./verify/story-to-tests.js";
import { EXIT_CODES, type AgentConfig } from "./types.js";
import type { ModelClient } from "./runtime/model.js";
import { CompositeTools, McpToolClient, type ServerSpec } from "./mcp/client.js";
import { buildReport, renderReportMarkdown } from "./mcp/discover.js";
import { DEFAULT_MANIFEST } from "./mcp/manifest.js";
import { azureDevOpsServer, playwrightServer } from "./mcp/servers.js";
import { FsTools } from "./mcp/adapters/fs.js";
import { Bdd2PwTools } from "./mcp/adapters/bdd2pw.js";
import { PwTools } from "./mcp/adapters/pw.js";
import { TcgTools } from "./mcp/adapters/tcg.js";
import { SynthdataTools } from "./mcp/adapters/synthdata.js";
import { ScopedGate, matchesAny } from "./governance/policy.js";
import { mask, scrub } from "./governance/scrub.js";
import type { ToolClient } from "./runtime/tools.js";

export const VERSION = "0.1.0-dev.0";

/** In-process adapters, by `--servers` name. */
export const LOCAL_SERVERS = ["fs", "bdd2pw", "pw", "tcg", "synthdata"];
/**
 * `tcg` and `synthdata` are site-specific (they need TCG_URL / SYNTHDATA_CMD),
 * so they are opt-in rather than on by default.
 */
export const DEFAULT_SERVERS = "ado,playwright,fs,bdd2pw,pw";

const USAGE = `aqa — agentic QA runtime

Usage:
  aqa replay <path> [--out <file>]
      Render a ledger to Markdown (no network, no tools). <path> is a run dir, a ledger
      root (uses the latest run), or an events.jsonl file.

  aqa discover [--servers ado,playwright,fs,bdd2pw,pw] [--out docs/tools-observed.md] [--workspace .]
      Spawn the MCP servers, list their tools, and write the observed names + schemas.
      Reads .env for credentials. Makes NO tool calls — listTools() only.

  aqa run "<request>" --config <ai-quality.config.yaml> [--ledger .aqa]
          [--approval terminal|file] [--work-item <id>] [--dry-run]
          [--servers ...] [--workspace .] [--env .env]
      Run the agent loop. The work item comes from the request ("AB#1") unless
      --work-item says otherwise, and must be in agent.scope.work_items.
      --dry-run: load config, connect servers, list tools with their gate class,
      make no model or tool calls, exit 0.
      Exit codes: 0 done, 1 error, 2 blocked, 3 refused, 4 budget.

  aqa --version | -v      aqa --help | -h
`;

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

export async function main(argv: string[], io: CliIo = stdio()): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (!cmd || cmd === "--help" || cmd === "-h") return (io.out(USAGE), 0);
    if (cmd === "--version" || cmd === "-v") return (io.out(`${VERSION}\n`), 0);
    if (cmd === "replay") return replay(rest, io);
    if (cmd === "discover") return await discover(rest, io);
    if (cmd === "run") return await run(rest, io);
    io.err(`Unknown command: ${cmd}\n\n${USAGE}`);
    return 1;
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(`aqa: config error: ${e.message}\n`);
      return 1;
    }
    io.err(`aqa: ${(e as Error).message}\n`);
    return 1;
  }
}

function stdio(): CliIo {
  return {
    out: (s) => {
      process.stdout.write(s);
    },
    err: (s) => {
      process.stderr.write(s);
    },
  };
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function replay(args: string[], io: CliIo): number {
  const target = positional(args)[0];
  if (!target) return (io.err("aqa replay: missing <path>\n"), 1);
  const out = flag(args, "--out");
  const file = resolveLedgerFile(resolve(target));
  if (!file) return (io.err(`aqa replay: no ${LEDGER_FILE} found under ${target}\n`), 1);
  const events = readLedgerFile(file);
  const md = renderMarkdown(events);
  if (out && out !== "-") {
    if (out !== "/dev/null" && out !== "NUL") writeFileSync(out, md, "utf8");
    io.err(`aqa replay: ${events.length} events from ${file}\n`);
  } else io.out(md);
  return 0;
}

/** Accept a run dir, a ledger root (`<root>/runs/*`), or the jsonl file itself. */
export function resolveLedgerFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).isFile()) return path;
  const direct = join(path, LEDGER_FILE);
  if (existsSync(direct)) return direct;
  const runs = join(path, "runs");
  if (existsSync(runs) && statSync(runs).isDirectory()) {
    const latest = readdirSync(runs)
      .filter((d) => existsSync(join(runs, d, LEDGER_FILE)))
      .sort()
      .pop();
    if (latest) return join(runs, latest, LEDGER_FILE);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// discover / run --dry-run
// ---------------------------------------------------------------------------

export interface ToolingDeps {
  /** Override for tests: build the tool client instead of spawning servers. */
  buildTools?: (
    specs: ServerSpec[],
    workspace: string,
  ) => Promise<{ tools: ToolClient; close: () => Promise<void> }>;
  /** Override for tests: supply the model instead of calling Anthropic. */
  buildModel?: (env: RuntimeEnv, config: AgentConfig) => ModelClient;
}

async function buildTooling(
  args: string[],
  io: CliIo,
  deps: ToolingDeps,
): Promise<{
  specs: ServerSpec[];
  tools: ToolClient;
  close: () => Promise<void>;
  workspace: string;
}> {
  loadDotEnv(flag(args, "--env") ?? ".env");
  const env = readRuntimeEnv(process.env, { requireAnthropic: false });
  const workspace = resolve(flag(args, "--workspace") ?? ".");
  const wanted = (flag(args, "--servers") ?? DEFAULT_SERVERS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const specs: ServerSpec[] = [];
  for (const w of wanted) {
    if (w === "ado") {
      if (!env.azureDevOps)
        throw new ConfigError(
          "--servers includes ado but AZURE_DEVOPS_ORG_URL/PAT/PROJECT are not set",
        );
      specs.push(azureDevOpsServer(env));
    } else if (w === "playwright") specs.push(playwrightServer());
    else if (w === "tcg" && !env.tcgUrl)
      throw new ConfigError("--servers includes tcg but TCG_URL is not set");
    else if (w === "synthdata" && !env.synthdataCmd)
      throw new ConfigError("--servers includes synthdata but SYNTHDATA_CMD is not set");
    else if (!LOCAL_SERVERS.includes(w))
      throw new ConfigError(
        `unknown server "${w}" (known: ado, playwright, ${LOCAL_SERVERS.join(", ")})`,
      );
  }
  if (env.azureDevOps)
    io.err(
      `aqa: Azure DevOps org ${env.azureDevOps.org}, project ${env.azureDevOps.project}, PAT ${mask(env.azureDevOps.pat)}\n`,
    );

  const built = deps.buildTools
    ? await deps.buildTools(specs, workspace)
    : await (async () => {
        const mcp = new McpToolClient(specs, DEFAULT_MANIFEST);
        const clients: ToolClient[] = specs.length > 0 ? [mcp] : [];
        if (wanted.includes("fs")) clients.push(new FsTools(workspace));
        if (wanted.includes("bdd2pw")) clients.push(new Bdd2PwTools(workspace));
        if (wanted.includes("pw")) clients.push(new PwTools(workspace));
        if (wanted.includes("tcg") && env.tcgUrl) clients.push(new TcgTools(env.tcgUrl));
        if (wanted.includes("synthdata") && env.synthdataCmd)
          clients.push(new SynthdataTools(env.synthdataCmd, workspace));
        return { tools: new CompositeTools(clients), close: () => mcp.close() };
      })();
  return { specs, ...built, workspace };
}

export async function discover(args: string[], io: CliIo, deps: ToolingDeps = {}): Promise<number> {
  const out = flag(args, "--out") ?? "docs/tools-observed.md";
  const { specs, tools, close } = await buildTooling(args, io, deps);
  try {
    io.err(`aqa discover: connecting to ${specs.length} MCP server(s)…\n`);
    const list = await tools.listTools();
    const report = buildReport(
      [
        ...specs,
        ...LOCAL_SERVERS.filter((n) => list.some((t) => t.server === n)).map((name) => ({
          name,
          command: "(in-process)",
          args: [],
        })),
      ],
      list,
      DEFAULT_MANIFEST,
    );
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(out, renderReportMarkdown(report), "utf8");
    writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(report, null, 2), "utf8");
    const unclassified = report.tools.filter((t) => !t.classified).length;
    io.out(
      `aqa discover: ${report.tools.length} tools from ${report.servers.length} server(s); ${unclassified} unclassified → ${out}\n`,
    );
    for (const t of report.tools) io.out(`  ${t.classified ? " " : "!"} ${t.qualified}\n`);
    return 0;
  } finally {
    await close();
  }
}

export async function run(args: string[], io: CliIo, deps: ToolingDeps = {}): Promise<number> {
  const request = positional(args)[0];
  if (!request) return (io.err(`aqa run: missing "<request>"\n`), 1);
  const configPath = flag(args, "--config");
  if (!configPath) return (io.err("aqa run: --config <ai-quality.config.yaml> is required\n"), 1);
  const config = await loadAgentConfig(configPath);

  if (!args.includes("--dry-run")) return live(request, args, config, io, deps);
  const { tools, close } = await buildTooling(args, io, deps);
  try {
    const list = await tools.listTools();
    const gate = new ScopedGate(config.policy, config.scope, {
      sandbox: process.env["AQA_SANDBOX"] === "1",
    });
    io.out(`aqa run --dry-run: "${request}"\n`);
    io.out(
      `  config: model ${config.model}, budgets ${config.budgets.steps} steps / ${config.budgets.tokens} tokens\n`,
    );
    io.out(
      `  scope: work_items ${config.scope.work_items.join(",") || "(none)"}; repos ${config.scope.repos.join(",") || "(none)"}; test_plans ${config.scope.test_plans.join(",") || "(none)"}\n`,
    );
    io.out(`  ${list.length} tools visible to the gate (class → table decision):\n`);
    for (const t of list) {
      const qname = `${t.server}.${t.name}`;
      io.out(`    ${qname}: ${t.policyClass} → ${config.policy[t.policyClass]}\n`);
      const actions = Object.entries(t.actions ?? {});
      for (const [action, a] of actions) {
        const verdict = gate.judge(
          { toolName: qname, args: { [t.actionArg ?? "action"]: action } },
          t,
        );
        io.out(
          `        ${t.actionArg}=${action}: ${a.policyClass} → ${config.policy[a.policyClass]}${scopeHint(verdict)}\n`,
        );
      }
      if (actions.length === 0) {
        const hint = scopeHint(gate.judge({ toolName: qname, args: {} }, t));
        if (hint) io.out(`       ${hint}\n`);
      }
    }
    io.out("  no model or tool calls were made.\n");
    return 0;
  } finally {
    await close();
  }
}

// ---------------------------------------------------------------------------

/**
 * A real run: model, tools, gate, approver, ledger, loop. Everything the dry
 * run describes, actually done (PLAN §1 A7).
 */
async function live(
  request: string,
  args: string[],
  config: AgentConfig,
  io: CliIo,
  deps: ToolingDeps,
): Promise<number> {
  loadDotEnv(flag(args, "--env") ?? ".env");
  // Read without demanding the API key first: refusing an out-of-scope request
  // should not require credentials, and the key is only needed once a model is
  // actually built.
  const env = readRuntimeEnv(process.env, { requireAnthropic: false });

  const approvalMode = flag(args, "--approval") ?? "terminal";
  if (approvalMode !== "file" && approvalMode !== "terminal") {
    io.err(`aqa run: --approval must be "terminal" or "file"\n`);
    return 1;
  }

  // The run is scoped to one story. Refuse before spending a token if the
  // request names a work item the config does not allow.
  const workItem = flag(args, "--work-item") ?? parseWorkItemRef(request);
  if (!workItem) {
    io.err('aqa run: no work item in the request. Write it as "AB#1", or pass --work-item <id>.\n');
    return 1;
  }
  if (!matchesAny(workItem, config.scope.work_items, env.sandbox)) {
    io.err(
      `aqa run: work item ${workItem} is not in agent.scope.work_items (${
        config.scope.work_items.join(", ") || "empty"
      }).\n`,
    );
    return EXIT_CODES.refused;
  }

  const ledger = new Ledger(flag(args, "--ledger") ?? ".aqa", newRunId());
  const approver =
    approvalMode === "file"
      ? new FileApprover({ dir: join(ledger.dir, APPROVALS_DIR) })
      : new TerminalApprover();

  const { tools, close, workspace } = await buildTooling(args, io, deps);
  try {
    const skill = storyToTestsSkill({ workItem });
    if (!deps.buildModel && !env.anthropicApiKey)
      throw new ConfigError("ANTHROPIC_API_KEY is not set");
    const model =
      deps.buildModel?.(env, config) ??
      new AnthropicModel({
        apiKey: env.anthropicApiKey,
        model: env.model ?? config.model,
        promptVersion: config.prompt_version,
        warn: (m) => io.err(`aqa: ${scrub(m).text}\n`),
      });

    io.err(`aqa run ${ledger.runId}: "${request}"\n`);
    io.err(
      `aqa: skill ${skill.name}, work item ${workItem}, model ${model.model}, approval ${approvalMode}\n`,
    );
    io.err(`aqa: ledger ${ledger.dir}\n`);

    const result = await runLoop({
      requestText: request,
      model,
      tools,
      gate: new ScopedGate(config.policy, config.scope, { sandbox: env.sandbox }),
      approver,
      skill,
      ledger,
      config,
      workspaceDir: workspace,
    });

    io.out(`\n${result.status}: ${result.summary}\n`);
    io.out(`  ${result.events} events in ${ledger.dir}\n`);
    io.out(`  replay: aqa replay ${ledger.dir}\n`);
    return result.exitCode;
  } finally {
    await close();
  }
}

/** Show, in the dry run, which argument a tool still needs before it can pass the gate. */
function scopeHint(v: { decision: string; reason: string }): string {
  return v.decision === "refuse" && /required for scope checks/.test(v.reason)
    ? ` — ${v.reason}`
    : "";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (a !== "--dry-run") i++; // skip the value of a --flag value pair
      continue;
    }
    out.push(a);
  }
  return out;
}

// Only run when invoked as the CLI entry (tsup banner adds the shebang).
const isEntry =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  /(^|[\\/])(cli\.(js|ts|mjs)|aqa)$/.test(process.argv[1] ?? "");
if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`aqa: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
