import type { PolicyClass } from "../types.js";

/**
 * A tool as the model sees it. `server` + `name` are how MCP addresses it; the
 * model refers to it by the qualified name "<server>.<name>".
 */
/**
 * Which arguments carry scope-bearing values, so the gate can check them
 * against the config allow-lists. Keys are scope dimensions, values are
 * argument names in `inputSchema`. An argument holding a list (e.g. `ids`) is
 * checked element by element; every element must be in scope.
 */
export interface ScopeArgs {
  workItem?: string;
  repo?: string;
  testPlan?: string;
  branch?: string;
  /** Argument holding a URL, checked against `agent.scope.urls` (A8). */
  url?: string;
}

/** One operation of an action-multiplexed tool (see `ToolDescriptor.actions`). */
export interface ActionDescriptor {
  policyClass: PolicyClass;
  scopeArgs?: ScopeArgs;
}

export interface ToolDescriptor {
  server: string;
  name: string;
  description: string;
  /** JSON schema of the arguments, verbatim from the MCP server (design §6.3). */
  inputSchema: Record<string, unknown>;
  /**
   * Governance class assigned by the tool manifest. The gate may raise it
   * (never lower it) after inspecting arguments — e.g. a branch write to a
   * protected branch becomes `destructive`. For an action-multiplexed tool
   * this is the WORST case over `actions`: it is what the model is told, so
   * the model is never under-warned about what a tool can do.
   */
  policyClass: PolicyClass;
  scopeArgs?: ScopeArgs;
  /**
   * Name of the argument that selects the operation, for tools that multiplex
   * several operations behind one name. Microsoft's Azure DevOps MCP server
   * does this throughout (`action: "get" | "reorder" | …`), mixing reads and
   * writes under one tool, so a class per TOOL would be either too loose or
   * too tight. When set, the gate resolves the class from `actions[action]`.
   */
  actionArg?: string;
  /**
   * The operations this tool is allowed to perform, keyed by the value of
   * `actionArg`. An action that is absent here is unclassified and therefore
   * refused, exactly like an unknown tool.
   */
  actions?: Record<string, ActionDescriptor>;
  /**
   * Arguments the runtime fills in when the model omits them — currently the
   * Azure DevOps project. Merged BEFORE the gate sees the call, so the ledger
   * and the policy decision both describe what was actually sent (A8).
   */
  defaultArgs?: Record<string, unknown>;
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
