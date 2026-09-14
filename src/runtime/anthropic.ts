import { scrub } from "../governance/scrub.js";
import type { HistoryItem, ModelClient, ModelDecision, ModelInput, ModelUsage } from "./model.js";
import type { ToolDescriptor } from "./tools.js";

/**
 * The slice of the Anthropic SDK this package uses. Kept as our own interface
 * so the suite injects a fake and the SDK is imported only when a real run
 * happens (same approach as the MCP client).
 */
export interface MessagesApi {
  create(body: MessageRequest): Promise<MessageResponse>;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: "auto" | "any" | "none" };
  temperature?: number;
}

export interface MessageResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: string; [k: string]: unknown }
  >;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export type MessagesFactory = (apiKey: string) => Promise<MessagesApi>;

/** Default: the official SDK, imported lazily so unit tests never need it. */
export const sdkMessagesFactory: MessagesFactory = async (apiKey) => {
  const mod = (await import("@anthropic-ai/sdk")) as unknown as {
    default: new (opts: { apiKey: string }) => { messages: MessagesApi };
  };
  const Anthropic = mod.default;
  return new Anthropic({ apiKey }).messages;
};

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  promptVersion?: string;
  maxTokens?: number;
  /** Injected for tests. */
  factory?: MessagesFactory;
  /** Where to report non-fatal adapter problems. Scrubbed before writing. */
  warn?: (message: string) => void;
}

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_PROMPT_VERSION = "aqa-prompt-v0.1.0";

/**
 * The runtime's own instructions, ahead of the skill's. These describe the
 * MACHINE the model is driving; the skill describes the JOB.
 */
export const RUNTIME_SYSTEM = `You are the reasoning step of an agentic QA runtime. You choose the next action; you do not perform it.

How a cycle works. You are given the request, the tools you may use, primary
sources you have already read, and a history of what has happened. You reply
with one or more tool calls, or with no tool calls at all — which means "I
believe the goal is reached" and hands over to a verifier that checks the run
ledger. The verifier decides done, not you.

What happens to your tool calls. Each one is classified by a governance gate
before it runs: it may execute, it may be put to a human for approval, or it may
be refused. A refusal is final for that call — the gate's decision will not
change on a retry, so read the reason and choose a different route. Refused and
denied calls come back to you in the history with their reason.

Rules.
- Call tools only from the provided list, with the exact names given.
- Fill in every argument the schema requires. A call missing an argument the gate
  needs to check scope is refused without being executed.
- Prefer several independent calls in one reply over one call per cycle; they are
  gated together and, where approval is needed, presented to the human as one
  request.
- Never claim a step succeeded. The ledger records what actually happened, and
  the verifier reads the ledger rather than your summary.
- If you cannot make progress, say so plainly with no tool calls and explain what
  is blocking you. An honest stop is a better outcome than invented progress.`;

/**
 * Anthropic Messages API adapter.
 *
 * Note what this deliberately does NOT do: it does not maintain an API-side
 * conversation with tool_result turns. Every cycle is a fresh, self-contained
 * request assembled from the ledger by the context builder. The ledger is the
 * memory, which is what makes a run replayable and auditable after the fact —
 * a conversation living inside the provider's message history would not be.
 */
export class AnthropicModel implements ModelClient {
  readonly model: string;
  readonly promptVersion: string;
  private readonly apiKey: string;
  private readonly maxTokens: number;
  private readonly factory: MessagesFactory;
  private readonly warn: (m: string) => void;
  private api: MessagesApi | undefined;

  constructor(opts: AnthropicModelOptions) {
    if (!opts.apiKey) throw new Error("AnthropicModel requires an API key");
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.promptVersion = opts.promptVersion ?? DEFAULT_PROMPT_VERSION;
    // A generated spec for half a dozen scenarios does not fit in 4k.
    this.maxTokens = opts.maxTokens ?? 8192;
    this.factory = opts.factory ?? sdkMessagesFactory;
    this.warn = opts.warn ?? (() => {});
  }

  private async messages(): Promise<MessagesApi> {
    this.api ??= await this.factory(this.apiKey);
    return this.api;
  }

  async plan(input: ModelInput): Promise<{ steps: string[]; usage: ModelUsage }> {
    const res = await (
      await this.messages()
    ).create({
      model: this.model,
      max_tokens: Math.min(this.maxTokens, 1024),
      system: scrub(`${RUNTIME_SYSTEM}\n\n---\n\n${input.skillInstructions}`).text,
      messages: [
        {
          role: "user",
          content: scrub(
            `${renderRequest(input)}\n\nOutline how you will approach this, as a short numbered list of steps. Do not call any tools yet.`,
          ).text,
        },
      ],
    });
    return { steps: parseSteps(textOf(res)), usage: usageOf(res) };
  }

  async decide(input: ModelInput): Promise<ModelDecision> {
    const { tools, toByWire } = wireTools(input.tools);
    const res = await (
      await this.messages()
    ).create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: scrub(`${RUNTIME_SYSTEM}\n\n---\n\n${input.skillInstructions}`).text,
      messages: [{ role: "user", content: scrub(renderCycle(input)).text }],
      tools,
      tool_choice: { type: "auto" },
    });

    const calls: ModelDecision["calls"] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const b = block as { name: string; input: Record<string, unknown> };
      const qualified = toByWire.get(b.name);
      if (!qualified) {
        // The model invented a tool name. Drop it rather than passing it to the
        // gate as an unknown tool — but say so, because it means the schema
        // round-trip is wrong somewhere.
        this.warn(`model proposed unknown tool "${b.name}"; dropped`);
        continue;
      }
      calls.push({ toolName: qualified, args: b.input ?? {} });
    }

    const note = textOf(res).trim();
    const decision: ModelDecision = { calls, usage: usageOf(res) };
    if (note) decision.note = note;
    return decision;
  }
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Tool names in the Messages API must match ^[a-zA-Z0-9_-]{1,128}$, but ours
 * are qualified with a dot ("ado.wit_work_item"). Map the dot to "__" on the
 * way out and back on the way in, so the ledger keeps the qualified name and
 * the API gets a legal one.
 */
export function toWireName(qualified: string): string {
  return qualified.replace(/\./g, "__");
}

export function fromWireName(wire: string): string {
  return wire.replace(/__/g, ".");
}

export function wireTools(descriptors: ToolDescriptor[]): {
  tools: NonNullable<MessageRequest["tools"]>;
  toByWire: Map<string, string>;
} {
  const toByWire = new Map<string, string>();
  const tools = descriptors.map((d) => {
    const qualified = `${d.server}.${d.name}`;
    const wire = toWireName(qualified);
    toByWire.set(wire, qualified);
    return {
      name: wire,
      description: describeTool(d),
      input_schema: normaliseSchema(d.inputSchema),
    };
  });
  return { tools, toByWire };
}

/**
 * The description the model sees. Beyond the server's own text it states the
 * governance class and, for action-multiplexed tools, exactly which actions are
 * permitted — so the model learns the boundary from the tool definition rather
 * than by being refused.
 */
function describeTool(d: ToolDescriptor): string {
  const parts = [d.description || `${d.server} ${d.name}`];
  const actions = Object.entries(d.actions ?? {});
  if (actions.length > 0 && d.actionArg) {
    parts.push(
      `Permitted ${d.actionArg} values: ${actions
        .map(([name, a]) => `"${name}" (${a.policyClass})`)
        .join(", ")}. Any other ${d.actionArg} is refused.`,
    );
  } else {
    parts.push(`Governance class: ${d.policyClass}.`);
  }
  const scoped = [d.scopeArgs, ...actions.map(([, a]) => a.scopeArgs)].filter(Boolean);
  const args = [...new Set(scoped.flatMap((s) => Object.values(s ?? {})))];
  if (args.length > 0) {
    parts.push(
      `Scope-checked argument(s): ${args.join(", ")} — required, and checked against the run's allow-list.`,
    );
  }
  return parts.join(" ");
}

/** The API requires an object schema; some servers return an empty or odd one. */
export function normaliseSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && schema["type"] === "object") return schema;
  const properties = schema && isObject(schema["properties"]) ? schema["properties"] : {};
  return { type: "object", properties };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function renderRequest(input: ModelInput): string {
  return `# Request\n\n${input.request}`;
}

/** One cycle's user message: request, sources, history, gaps — in that order. */
export function renderCycle(input: ModelInput): string {
  const sections: string[] = [renderRequest(input)];

  const sources = input.history.filter(isSourceLike);
  const steps = input.history.filter((h) => !isSourceLike(h));

  if (sources.length > 0) {
    sections.push(`# Sources already read\n\n${sources.map(renderItem).join("\n\n")}`);
  }
  if (steps.length > 0) {
    sections.push(`# What has happened so far\n\n${steps.map(renderItem).join("\n\n")}`);
  }
  if (input.notes && input.notes.length > 0) {
    sections.push(
      `# What you said in earlier cycles\n\nYour reasoning is not carried over automatically; this is it, oldest first. Continue from it rather than starting again.\n\n${input.notes
        .map((n) => `- ${n}`)
        .join("\n")}`,
    );
  }
  if (input.gaps && input.gaps.length > 0) {
    sections.push(
      `# The verifier rejected the run\n\nYou said the goal was reached; it is not. These gaps remain, and this is your last attempt:\n\n${input.gaps
        .map((g) => `- ${g}`)
        .join("\n")}`,
    );
  }
  sections.push(
    `# Now\n\nChoose the next action. Reply with tool calls, or with no tool calls if you believe the goal is reached. Re-reading something already shown above changes nothing and will be refused — if you have what you need, act on it.`,
  );
  return sections.join("\n\n");
}

/** Context assembly marks primary sources; the adapter does not re-decide. */
function isSourceLike(h: HistoryItem): boolean {
  return h.source === true;
}

function renderItem(h: HistoryItem): string {
  const head = `## ${h.toolName} (${h.ok ? "ok" : "failed"}, ${h.ledgerRef})`;
  if (h.gate) return `${head}\n\n${h.gate.decision.toUpperCase()}: ${h.gate.reason}`;
  return `${head}\n\n${h.summary}`;
}

function textOf(res: MessageResponse): string {
  return res.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function usageOf(res: MessageResponse): ModelUsage {
  return {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
  };
}

/** "1. Read the story" → ["Read the story"]; falls back to non-empty lines. */
export function parseSteps(text: string): string[] {
  const numbered = text
    .split(/\r?\n/)
    .map((l) => /^\s*(?:\d+[.)]|[-*])\s+(.*)$/.exec(l.trim())?.[1]?.trim())
    .filter((s): s is string => Boolean(s));
  if (numbered.length > 0) return numbered;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.slice(0, 10);
}
