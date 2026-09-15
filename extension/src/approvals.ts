import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import * as vscode from "vscode";

export interface ApprovalCall {
  toolName: string;
  args: Record<string, unknown>;
}

/** The on-disk contract written by the runtime's `--approval file` mode. */
export interface ApprovalRecord {
  approvalId: string;
  summary: string;
  calls: ApprovalCall[];
  requestedAt: string;
  decision: "approved" | "denied" | null;
  by?: string;
  at?: string;
}

function readRecord(file: string): ApprovalRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Partial<ApprovalRecord>;
    if (typeof record.approvalId !== "string" || !Array.isArray(record.calls)) return undefined;
    return record as ApprovalRecord;
  } catch {
    // A partially written file: the watcher will fire again on completion.
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One readable line per argument — the reviewer is deciding on these values. */
function renderArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "    (no arguments)";
  return keys
    .map((key) => {
      const value = args[key];
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return `    ${key}: ${truncate(rendered ?? String(value), 240)}`;
    })
    .join("\n");
}

export function renderDetail(record: ApprovalRecord): string {
  const body = record.calls
    .map((call, i) => `${i + 1}. ${call.toolName}\n${renderArgs(call.args)}`)
    .join("\n\n");
  return `${body}\n\nApproving runs all ${record.calls.length} call${
    record.calls.length === 1 ? "" : "s"
  }. Dismissing this dialog denies them.`;
}

function decide(file: string, record: ApprovalRecord, decision: "approved" | "denied"): void {
  const updated: ApprovalRecord = {
    ...record,
    decision,
    by: `vscode:${userInfo().username}`,
    at: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
}

/**
 * Watches for approval requests and answers them from the editor.
 *
 * Two properties are load-bearing and deliberately not configurable:
 * dismissing the dialog denies, and the approve button is never the default —
 * an approval that can be collected by pressing Enter is not an approval.
 */
export class ApprovalWatcher implements vscode.Disposable {
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly handled = new Set<string>();
  private readonly status: vscode.StatusBarItem;
  private pending: { file: string; record: ApprovalRecord } | undefined;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    ledgerDir: string,
    private readonly log: vscode.OutputChannel,
  ) {
    const pattern = new vscode.RelativePattern(folder, `${ledgerDir}/runs/*/approvals/*.json`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidCreate((uri) => void this.consider(uri));
    this.watcher.onDidChange((uri) => void this.consider(uri));

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = "aqa.openPendingApproval";
    this.status.text = "$(shield) AQA: approval needed";
    this.status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }

  /** Re-prompt for whatever is still waiting — the status bar item's command. */
  async promptPending(): Promise<void> {
    if (!this.pending) {
      void vscode.window.showInformationMessage("No approval is waiting.");
      return;
    }
    await this.prompt(this.pending.file, this.pending.record, { reprompt: true });
  }

  private async consider(uri: vscode.Uri): Promise<void> {
    const file = uri.fsPath;
    const record = readRecord(file);
    if (!record) return;
    if (record.decision !== null) {
      // Someone answered it — here, at a terminal, or by editing the file.
      if (this.pending?.file === file) this.clearPending();
      return;
    }
    if (this.handled.has(record.approvalId)) return;
    await this.prompt(file, record, { reprompt: false });
  }

  private async prompt(
    file: string,
    record: ApprovalRecord,
    opts: { reprompt: boolean },
  ): Promise<void> {
    if (!opts.reprompt) this.handled.add(record.approvalId);
    this.pending = { file, record };
    this.status.show();

    const approve = `Approve ${record.calls.length} call${record.calls.length === 1 ? "" : "s"}`;
    const review = "Open the request";
    const choice = await vscode.window.showWarningMessage(
      record.summary,
      { modal: true, detail: renderDetail(record) },
      approve,
      review,
    );

    if (choice === review) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
      // Still unanswered: leave it pending so the status bar can re-ask.
      this.log.appendLine(`approval ${record.approvalId}: opened for review, still unanswered`);
      return;
    }

    const decision = choice === approve ? "approved" : "denied";
    try {
      decide(file, record, decision);
      this.log.appendLine(
        `approval ${record.approvalId}: ${decision}${
          decision === "denied" && choice === undefined ? " (dialog dismissed)" : ""
        }`,
      );
    } catch (err) {
      // If we cannot write the decision the run will time out, which denies.
      // Say so rather than letting the user believe they approved something.
      void vscode.window.showErrorMessage(
        `Could not write the approval decision: ${String(err)}. The run will treat this as denied.`,
      );
    }
    this.clearPending();
  }

  private clearPending(): void {
    this.pending = undefined;
    this.status.hide();
  }

  dispose(): void {
    this.watcher.dispose();
    this.status.dispose();
  }

  /** Exposed for the runner, which wants the folder it is watching. */
  get workspaceFolder(): vscode.WorkspaceFolder {
    return this.folder;
  }
}
