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

/**
 * Windows will not spawn a `.cmd` or `.bat` directly any more — Node rejects it
 * with EINVAL since the 2024 batch-file argument-injection fix — so a batch
 * launcher is run through the command interpreter explicitly. Arguments are
 * still passed as an ARRAY, never concatenated into a command line, and
 * `shell` stays false: this is not "run it in a shell", it is "run cmd.exe with
 * these exact arguments".
 */
export function spawnable(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  const comspec = process.env["ComSpec"] ?? "cmd.exe";
  return { command: comspec, args: ["/d", "/s", "/c", command, ...args] };
}

/** Default runner: no shell, so nothing in an argument can be interpreted. */
export const execFileRunner: CommandRunner = (command, args, opts) =>
  new Promise((resolve) => {
    const spawned = spawnable(command, args);
    execFile(
      spawned.command,
      spawned.args,
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
