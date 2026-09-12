import type { PolicyClass } from "../types.js";

/**
 * A tool as the model sees it. `server` + `name` are how MCP addresses it; the
 * model refers to it by the qualified name "<server>.<name>".
 */
export interface ToolDescriptor {
  server: string;
  name: string;
  description: string;
  /** JSON schema of the arguments, verbatim from the MCP server (design §6.3). */
  inputSchema: Record<string, unknown>;
  /**
   * Governance class assigned by the tool manifest. The gate may raise it
   * (never lower it) after inspecting arguments — e.g. a branch write to a
   * protected branch becomes `destructive`.
   */
  policyClass: PolicyClass;
  /**
   * Which arguments carry scope-bearing values, so the gate can check them
   * against the config allow-lists. Keys are scope dimensions, values are
   * argument names in `inputSchema`.
   */
  scopeArgs?: {
    workItem?: string;
    repo?: string;
    testPlan?: string;
    branch?: string;
  };
}

export interface ToolResult {
  ok: boolean;
  result: unknown;
  /** Relative paths (within the workspace) of files the tool produced. */
  artefacts: string[];
}

export interface ToolClient {
  listTools(): Promise<ToolDescriptor[]>;
  call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export function qualify(server: string, name: string): string {
  return `${server}.${name}`;
}

export function splitQualified(toolName: string): { server: string; name: string } | undefined {
  const i = toolName.indexOf(".");
  if (i <= 0 || i === toolName.length - 1) return undefined;
  return { server: toolName.slice(0, i), name: toolName.slice(i + 1) };
}

export type StubHandler = (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>;

/**
 * In-memory tool client. Each tool has a descriptor and a handler (or a fixed
 * result). Records every call for assertions.
 */
export class StubTools implements ToolClient {
  private readonly tools = new Map<string, { descriptor: ToolDescriptor; handler: StubHandler }>();
  readonly calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

  add(descriptor: ToolDescriptor, handler: StubHandler | ToolResult): this {
    const h: StubHandler = typeof handler === "function" ? handler : () => handler;
    this.tools.set(qualify(descriptor.server, descriptor.name), { descriptor, handler: h });
    return this;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [...this.tools.values()].map((t) => t.descriptor);
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const key = qualify(server, name);
    this.calls.push({ toolName: key, args });
    const t = this.tools.get(key);
    if (!t) return { ok: false, result: { message: `unknown tool ${key}` }, artefacts: [] };
    return t.handler(args);
  }
}
