import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const run = promisify(execFile);

/**
 * The extension and the runtime version independently on purpose: the ledger
 * event shapes are a contract, and a user pinning an older runtime must not be
 * forced to upgrade because the editor integration changed. So we locate
 * whatever `aqa` the user has rather than bundling one.
 */
export interface Runtime {
  /** Absolute path, or the bare command name when found on PATH. */
  command: string;
  version: string;
}

const PACKAGE = "@vijaypjavvadi/agentic-qa";
const BIN = process.platform === "win32" ? "aqa.cmd" : "aqa";

function candidates(folder: vscode.WorkspaceFolder): string[] {
  const configured = vscode.workspace
    .getConfiguration("aqa")
    .get<string>("executablePath", "")
    .trim();
  const found: string[] = [];
  if (configured) found.push(configured);
  found.push(join(folder.uri.fsPath, "node_modules", ".bin", BIN));
  // Bare name last: resolved by PATH, which is the common global-install case.
  found.push(BIN);
  return found;
}

async function versionOf(command: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(command, ["--version"], { timeout: 15_000 });
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the runtime, offering to install it when absent.
 *
 * Returns `undefined` when it could not be found and the user declined to
 * install — the caller should abandon the command quietly rather than erroring,
 * because the user has already been told what is missing.
 */
export async function resolveRuntime(
  folder: vscode.WorkspaceFolder,
  opts: { silent?: boolean } = {},
): Promise<Runtime | undefined> {
  for (const command of candidates(folder)) {
    // A configured path that does not exist is worth saying out loud rather
    // than silently falling through to PATH and running a different binary.
    if (command !== BIN && !existsSync(command)) continue;
    const version = await versionOf(command);
    if (version) return { command, version };
  }

  if (opts.silent) return undefined;

  const install = "Install globally";
  const choose = "Choose path…";
  const answer = await vscode.window.showWarningMessage(
    `The agentic-qa runtime was not found.`,
    { modal: false },
    install,
    choose,
  );

  if (answer === choose) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      openLabel: "Use this aqa executable",
      title: "Locate the aqa executable",
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return undefined;
    const version = await versionOf(file);
    if (!version) {
      void vscode.window.showErrorMessage(`${file} did not respond to --version.`);
      return undefined;
    }
    await vscode.workspace
      .getConfiguration("aqa")
      .update("executablePath", file, vscode.ConfigurationTarget.Workspace);
    return { command: file, version };
  }

  if (answer === install) {
    // A terminal rather than a silent exec: a global install is the user's
    // machine and they should be able to see and stop it.
    const terminal = vscode.window.createTerminal("Agentic QA install");
    terminal.show();
    terminal.sendText(`npm install -g ${PACKAGE}`);
    void vscode.window.showInformationMessage(
      "Installing. When it finishes, run the command again.",
    );
  }

  return undefined;
}
