import { spawn } from "node:child_process";
import { join } from "node:path";
import * as vscode from "vscode";
import { ApprovalWatcher } from "./approvals";
import { RunsTreeProvider, type RunEvent, type RunSummary } from "./ledger";
import { resolveRuntime } from "./runtime";

interface Settings {
  configFile: string;
  workspaceDir: string;
  ledgerDir: string;
  approvalTimeoutSeconds: number;
}

function settings(): Settings {
  const c = vscode.workspace.getConfiguration("aqa");
  return {
    configFile: c.get<string>("configFile", "ai-quality.config.yaml"),
    workspaceDir: c.get<string>("workspaceDir", "qa"),
    ledgerDir: c.get<string>("ledgerDir", ".aqa"),
    approvalTimeoutSeconds: c.get<number>("approvalTimeoutSeconds", 1800),
  };
}

function firstFolder(): vscode.WorkspaceFolder | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage("Open a folder before running Agentic QA.");
  }
  return folder;
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Agentic QA");
  context.subscriptions.push(log);

  const folder = vscode.workspace.workspaceFolders?.[0];
  const cfg = settings();

  const runs = new RunsTreeProvider(
    folder ? join(folder.uri.fsPath, cfg.ledgerDir) : cfg.ledgerDir,
  );
  context.subscriptions.push(vscode.window.registerTreeDataProvider("aqa.runs", runs));

  let approvals: ApprovalWatcher | undefined;
  if (folder) {
    approvals = new ApprovalWatcher(folder, cfg.ledgerDir, log);
    context.subscriptions.push(approvals);

    // Keep the tree honest while a run is writing to it.
    const ledgerWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, `${cfg.ledgerDir}/runs/*/events.jsonl`),
    );
    ledgerWatcher.onDidCreate(() => runs.refresh());
    ledgerWatcher.onDidChange(() => runs.refresh());
    context.subscriptions.push(ledgerWatcher);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("aqa")) return;
      const f = vscode.workspace.workspaceFolders?.[0];
      if (f) runs.setLedgerRoot(join(f.uri.fsPath, settings().ledgerDir));
    }),
  );

  const register = (id: string, handler: (...args: never[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown),
    );
  };

  register("aqa.refreshRuns", () => runs.refresh());

  register("aqa.openPendingApproval", () => {
    if (!approvals) return;
    void approvals.promptPending();
  });

  register("aqa.showRuntimeVersion", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    void vscode.window.showInformationMessage(
      `agentic-qa ${runtime.version} — ${runtime.command}`,
    );
  });

  register("aqa.openEvent", async (run: RunSummary, event: RunEvent) => {
    const doc = await vscode.workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(event, null, 2),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
    log.appendLine(`opened event ${event.eventId} of ${run.runId}`);
  });

  register("aqa.runStory", () => void runStory(log, runs, false));
  register("aqa.dryRun", () => void runStory(log, runs, true));

  register("aqa.replayRun", async () => {
    const f = firstFolder();
    if (!f) return;
    const runtime = await resolveRuntime(f);
    if (!runtime) return;
    const root = join(f.uri.fsPath, settings().ledgerDir);
    await execToDocument(runtime.command, ["replay", root], f.uri.fsPath, log, "markdown");
  });
}

async function runStory(
  log: vscode.OutputChannel,
  runs: RunsTreeProvider,
  dryRun: boolean,
): Promise<void> {
  const folder = firstFolder();
  if (!folder) return;

  const runtime = await resolveRuntime(folder);
  if (!runtime) return;

  const ref = await vscode.window.showInputBox({
    title: dryRun ? "Agentic QA — dry run" : "Agentic QA — run story",
    prompt: "Work item to write tests for",
    placeHolder: "1",
    validateInput: (value) =>
      /^\d+$/.test(value.trim()) ? undefined : "Enter a work item id, digits only.",
  });
  if (!ref) return;

  const cfg = settings();
  const args = [
    "run",
    `Write tests for AB#${ref.trim()}`,
    "--config",
    cfg.configFile,
    "--workspace",
    cfg.workspaceDir,
    "--ledger",
    cfg.ledgerDir,
  ];
  if (dryRun) {
    args.push("--dry-run");
  } else {
    // File approval is what lets the editor answer instead of a terminal.
    args.push(
      "--approval",
      "file",
      "--approval-timeout",
      String(cfg.approvalTimeoutSeconds),
    );
  }

  log.show(true);
  log.appendLine(`\n$ ${runtime.command} ${args.map(quote).join(" ")}`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: dryRun ? `Dry run for AB#${ref.trim()}` : `Running AB#${ref.trim()}`,
      cancellable: true,
    },
    (_progress, token) =>
      new Promise<void>((resolve) => {
        const child = spawn(runtime.command, args, {
          cwd: folder.uri.fsPath,
          shell: false,
        });

        token.onCancellationRequested(() => {
          log.appendLine("cancelled — terminating the run");
          child.kill();
        });

        child.stdout.on("data", (d: Buffer) => log.append(d.toString()));
        child.stderr.on("data", (d: Buffer) => log.append(d.toString()));

        child.on("error", (err) => {
          log.appendLine(`failed to start: ${err.message}`);
          void vscode.window.showErrorMessage(`Could not start aqa: ${err.message}`);
          resolve();
        });

        child.on("close", (code) => {
          log.appendLine(`\nexit ${code ?? "?"}`);
          runs.refresh();
          report(code, dryRun);
          resolve();
        });
      }),
  );
}

/**
 * Exit codes are a contract: 0 done, 1 error, 2 blocked, 3 refused, 4 budget.
 * Only one of those is a failure. A blocked run is the governance machinery
 * doing its job, and reporting it as an error teaches people to ignore it.
 */
function report(code: number | null, dryRun: boolean): void {
  switch (code) {
    case 0:
      void vscode.window.showInformationMessage(
        dryRun ? "Dry run finished." : "Run finished. Open the Runs view for the ledger.",
      );
      return;
    case 2:
      void vscode.window.showWarningMessage(
        "Run blocked — an approval was denied or timed out. Nothing was written.",
      );
      return;
    case 3:
      void vscode.window.showWarningMessage(
        "Run refused — the agent proposed something the policy table does not allow.",
      );
      return;
    case 4:
      void vscode.window.showWarningMessage(
        "Run hit its budget. Raise budgets.steps or budgets.tokens in the config if that was too tight.",
      );
      return;
    default:
      void vscode.window.showErrorMessage(
        `Run failed (exit ${code ?? "?"}). See the Agentic QA output for why.`,
      );
  }
}

function quote(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

async function execToDocument(
  command: string,
  args: string[],
  cwd: string,
  log: vscode.OutputChannel,
  language: string,
): Promise<void> {
  const output = await new Promise<string>((resolve) => {
    let buffer = "";
    const child = spawn(command, args, { cwd, shell: false });
    child.stdout.on("data", (d: Buffer) => (buffer += d.toString()));
    child.stderr.on("data", (d: Buffer) => log.append(d.toString()));
    child.on("error", (err) => resolve(`Could not run ${command}: ${err.message}`));
    child.on("close", () => resolve(buffer));
  });

  if (!output.trim()) {
    void vscode.window.showInformationMessage("Nothing to replay yet — no runs found.");
    return;
  }
  const doc = await vscode.workspace.openTextDocument({ language, content: output });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function deactivate(): void {
  // Nothing to tear down: everything registered goes through context.subscriptions.
}
