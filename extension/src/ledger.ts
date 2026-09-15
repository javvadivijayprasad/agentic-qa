import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";

export const LEDGER_FILE = "events.jsonl";

/** The envelope every ledger line carries. */
export interface RunEvent {
  tool: string;
  runId: string;
  eventId: number;
  timestamp: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface RunSummary {
  runId: string;
  dir: string;
  events: number;
  status: string;
  startedAt: number | undefined;
}

function isEvent(value: unknown): value is RunEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<RunEvent>;
  return typeof e.eventId === "number" && typeof e.kind === "string";
}

/**
 * Read a run's events. A partial last line is skipped rather than thrown on —
 * the ledger is appended to while we are reading it.
 */
export function readEvents(file: string): RunEvent[] {
  if (!existsSync(file)) return [];
  const events: RunEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isEvent(parsed)) events.push(parsed);
    } catch {
      continue;
    }
  }
  return events;
}

export function listRuns(ledgerRoot: string): RunSummary[] {
  const runsDir = join(ledgerRoot, "runs");
  if (!existsSync(runsDir)) return [];
  const runs: RunSummary[] = [];
  for (const name of readdirSync(runsDir)) {
    const dir = join(runsDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const events = readEvents(join(dir, LEDGER_FILE));
    const end = [...events].reverse().find((e) => e.kind === "end");
    const status =
      typeof end?.payload?.["status"] === "string"
        ? (end.payload["status"] as string)
        : events.length > 0
          ? "running"
          : "empty";
    runs.push({
      runId: name,
      dir,
      events: events.length,
      status,
      startedAt: events[0]?.timestamp,
    });
  }
  // Run ids start with an ISO-ish stamp, so lexical descending is newest first.
  return runs.sort((a, b) => b.runId.localeCompare(a.runId));
}

/** One short line per event, the same shape the CLI's replay prints. */
export function describe(event: RunEvent): string {
  const p = event.payload ?? {};
  const str = (key: string): string | undefined =>
    typeof p[key] === "string" ? (p[key] as string) : undefined;

  switch (event.kind) {
    case "request":
      return str("request") ?? "run started";
    case "inference":
      return `chose ${str("toolName") ?? "a tool"}`;
    case "policy":
      return `${str("policyClass") ?? "?"} → ${str("decision") ?? "?"}`;
    case "call":
      return `calling ${str("toolName") ?? "?"}`;
    case "observation":
      return p["ok"] === true ? "ok" : "failed";
    case "approval_requested":
      return str("summary") ?? "approval requested";
    case "approval_resolved":
      return `${str("decision") ?? "?"} by ${str("by") ?? "?"}`;
    case "verify":
      return str("verdict") ?? "verified";
    case "end":
      return `${str("status") ?? "ended"} — ${str("reason") ?? ""}`.trim();
    default:
      return event.kind;
  }
}

type Node = { type: "run"; run: RunSummary } | { type: "event"; run: RunSummary; event: RunEvent };

export class RunsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private ledgerRoot: string) {}

  setLedgerRoot(root: string): void {
    this.ledgerRoot = root;
    this.refresh();
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === "run") {
      const item = new vscode.TreeItem(
        node.run.runId,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = `${node.run.status} · ${node.run.events} events`;
      item.iconPath = new vscode.ThemeIcon(iconForStatus(node.run.status));
      item.contextValue = "aqaRun";
      item.tooltip = node.run.dir;
      return item;
    }

    const item = new vscode.TreeItem(
      `${node.event.eventId}. ${node.event.kind}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = describe(node.event);
    item.iconPath = new vscode.ThemeIcon(iconForKind(node.event.kind));
    item.command = {
      command: "aqa.openEvent",
      title: "Open event",
      arguments: [node.run, node.event],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) return listRuns(this.ledgerRoot).map((run) => ({ type: "run", run }));
    if (node.type === "run") {
      return readEvents(join(node.run.dir, LEDGER_FILE)).map((event) => ({
        type: "event",
        run: node.run,
        event,
      }));
    }
    return [];
  }
}

function iconForStatus(status: string): string {
  switch (status) {
    case "done":
      return "pass";
    case "blocked":
      return "shield";
    case "refused":
      return "circle-slash";
    case "error":
      return "error";
    case "running":
      return "sync";
    default:
      return "circle-outline";
  }
}

function iconForKind(kind: string): string {
  switch (kind) {
    case "policy":
      return "law";
    case "call":
      return "play";
    case "observation":
      return "output";
    case "approval_requested":
    case "approval_resolved":
      return "shield";
    case "verify":
      return "verified";
    case "end":
      return "check";
    case "inference":
      return "sparkle";
    default:
      return "circle-small";
  }
}
