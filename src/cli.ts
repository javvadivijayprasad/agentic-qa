import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLedgerFile, LEDGER_FILE } from "./ledger/ledger.js";
import { renderMarkdown } from "./ledger/replay.js";

const USAGE = `aqa — agentic QA runtime

Usage:
  aqa replay <path> [--out <file>]     Render a ledger to Markdown (no network, no tools).
                                       <path> is a run dir, a ledger root (uses the latest run),
                                       or an events.jsonl file.
  aqa run "<request>" [...]            (not implemented yet — arrives in step A2+)
  aqa --version | -v
  aqa --help | -h
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === "replay") return replay(rest);
  if (cmd === "run") {
    process.stderr.write("aqa run is not implemented yet (step A2+). Use `aqa replay` for now.\n");
    return 1;
  }
  process.stderr.write(`Unknown command: ${cmd}\n\n${USAGE}`);
  return 1;
}

function replay(args: string[]): number {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    process.stderr.write("aqa replay: missing <path>\n");
    return 1;
  }
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;

  const file = resolveLedgerFile(resolve(target));
  if (!file) {
    process.stderr.write(`aqa replay: no ${LEDGER_FILE} found under ${target}\n`);
    return 1;
  }
  const events = readLedgerFile(file);
  const md = renderMarkdown(events);
  if (out && out !== "-") {
    if (out !== "/dev/null" && out !== "NUL") writeFileSync(out, md, "utf8");
    process.stderr.write(`aqa replay: ${events.length} events from ${file}\n`);
  } else {
    process.stdout.write(md);
  }
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

export const VERSION = "0.1.0-dev.0";

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
