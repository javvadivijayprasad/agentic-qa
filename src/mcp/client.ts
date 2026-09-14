import type { ToolClient, ToolDescriptor, ToolResult } from "../runtime/tools.js";
import { qualify } from "../runtime/tools.js";
import { classify, entryClass, type Manifest } from "./manifest.js";

/**
 * The slice of an MCP client session this package uses. Matches the shapes of
 * `@modelcontextprotocol/sdk`'s `Client.listTools()` / `Client.callTool()`
 * results; kept as our own interface so tests inject fakes and the SDK is only
 * imported when a real server is spawned.
 */
export interface McpSession {
  listTools(): Promise<{ tools: McpToolInfo[] }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** How to spawn one MCP server over stdio. */
export interface ServerSpec {
  /** Short name used in qualified tool names, e.g. "ado". */
  name: string;
  command: string;
  args: string[];
  /** Extra environment for the child. Values are never logged. */
  env?: Record<string, string>;
  cwd?: string;
  /**
   * Arguments to fill in on every tool of this server that declares them in its
   * input schema. Microsoft's Azure DevOps server ELICITS — asks the user a
   * question mid-call — when `project` is missing, and an elicitation a client
   * cannot answer is a failed call, so the runtime supplies it up front.
   */
  defaultArgs?: Record<string, unknown>;
}

export type SessionFactory = (spec: ServerSpec) => Promise<McpSession>;

/**
 * Default factory: spawns the server with the official SDK over stdio.
 * Lazy import keeps the SDK out of unit tests and out of `aqa replay`.
 */
export const sdkSessionFactory: SessionFactory = async (spec) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...filteredProcessEnv(), ...(spec.env ?? {}) },
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    stderr: "pipe",
  });
  const client = new Client({ name: "agentic-qa", version: "0.1.0" });
  await client.connect(transport);
  return {
    listTools: () => client.listTools() as Promise<{ tools: McpToolInfo[] }>,
    callTool: (p) => client.callTool(p) as Promise<McpCallResult>,
    close: () => client.close(),
  };
};

/** Pass the parent's env through (PATH, HOME, npm cache…) minus undefined values. */
function filteredProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

/**
 * ToolClient over one or more MCP servers. Tool descriptors carry the
 * governance class from the manifest; unknown tools are `destructive`.
 */
export class McpToolClient implements ToolClient {
  private sessions = new Map<string, McpSession>();
  private descriptors: ToolDescriptor[] = [];
  private connected = false;

  constructor(
    private readonly specs: ServerSpec[],
    private readonly manifest: Manifest,
    private readonly factory: SessionFactory = sdkSessionFactory,
  ) {
    const names = new Set<string>();
    for (const s of specs) {
      if (names.has(s.name)) throw new Error(`duplicate MCP server name "${s.name}"`);
      names.add(s.name);
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    for (const spec of this.specs) {
      const session = await this.factory(spec);
      this.sessions.set(spec.name, session);
      const { tools } = await session.listTools();
      for (const t of tools) {
        const entry = classify(qualify(spec.name, t.name), this.manifest);
        const d: ToolDescriptor = {
          server: spec.name,
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? {},
          // Worst case over the classified actions, so the model is never
          // under-warned about a tool that can also write.
          policyClass: entryClass(entry),
        };
        if (entry.scopeArgs) d.scopeArgs = entry.scopeArgs;
        if (entry.actionArg) d.actionArg = entry.actionArg;
        if (entry.actions) d.actions = entry.actions;
        const defaults = pickKnown(spec.defaultArgs, t.inputSchema);
        if (defaults) d.defaultArgs = defaults;
        this.descriptors.push(d);
      }
    }
    this.connected = true;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    await this.connect();
    return [...this.descriptors];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.connect();
    const session = this.sessions.get(server);
    if (!session)
      return { ok: false, result: { message: `no MCP server "${server}"` }, artefacts: [] };
    try {
      const r = await session.callTool({ name, arguments: args });
      return { ok: !r.isError, result: normaliseResult(r), artefacts: [] };
    } catch (e) {
      return { ok: false, result: { message: (e as Error).message }, artefacts: [] };
    }
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) {
      try {
        await s.close();
      } catch {
        /* best effort */
      }
    }
    this.sessions.clear();
    this.connected = false;
    this.descriptors = [];
  }
}

/** Only pass a default the tool actually declares, or the server rejects the call. */
function pickKnown(
  defaults: Record<string, unknown> | undefined,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!defaults) return undefined;
  const props = (schema?.["properties"] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults)) if (k in props) out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * MCP results are a list of content blocks. Prefer `structuredContent`; else
 * join text blocks and parse JSON when the whole text is JSON. Keep the raw
 * blocks alongside so nothing is lost (the ledger stores this verbatim).
 */
export function normaliseResult(r: McpCallResult): unknown {
  if (r.structuredContent !== undefined) return r.structuredContent;
  const texts = (r.content ?? []).filter((c) => c.type === "text" && typeof c.text === "string");
  if (texts.length === 0) return r.content ?? null;
  const joined = texts.map((c) => c.text as string).join("\n");
  const trimmed = joined.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* not JSON after all */
    }
  }
  return r.isError ? { message: joined } : joined;
}

/** Merge several ToolClients (e.g. MCP servers + in-process adapters) by server name. */
export class CompositeTools implements ToolClient {
  constructor(private readonly clients: ToolClient[]) {}
  async listTools(): Promise<ToolDescriptor[]> {
    const all = await Promise.all(this.clients.map((c) => c.listTools()));
    return all.flat();
  }
  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    for (const c of this.clients) {
      const tools = await c.listTools();
      if (tools.some((t) => t.server === server && t.name === name))
        return c.call(server, name, args);
    }
    return { ok: false, result: { message: `unknown tool ${server}.${name}` }, artefacts: [] };
  }
}
