import { execFile } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * How adapters run external commands. Injectable so every test runs without
 * spawning anything, and so a host (the platform) can supply its own sandbox.
 */
export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

/** Default runner: no shell, so nothing in an argument can be interpreted. */
export const execFileRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/**
 * Split a configured command line (e.g. `SYNTHDATA_CMD="python tools/synth.py"`)
 * into command + args. Whitespace-separated, with "quoted segments" kept
 * together. Deliberately NOT a shell: no globbing, no pipes, no substitution.
 */
export function splitCommand(cmd: string): { command: string; args: string[] } | undefined {
  const parts = cmd.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!parts || parts.length === 0) return undefined;
  const unquoted = parts.map((p) =>
    (p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))
      ? p.slice(1, -1)
      : p,
  );
  const [command, ...args] = unquoted as [string, ...string[]];
  return { command, args };
}
