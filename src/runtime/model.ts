import type { ToolDescriptor } from "./tools.js";

/** One proposed tool call. `toolName` is server-qualified: "<server>.<tool>". */
export interface ProposedCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * What the model returns each cycle: either one or more tool calls (parallel
 * tool use — all classified by the gate, executed in order), or `calls: []`
 * meaning "goal reached, hand over to the verifier".
 */
export interface ModelDecision {
  calls: ProposedCall[];
  /** Free text the model attached (kept in the ledger only via summary; never executed). */
  note?: string;
  usage: ModelUsage;
}

/** A compacted view of one earlier tool result, as the model sees it. */
export interface HistoryItem {
  toolName: string;
  ok: boolean;
  /** Compacted result text (context assembly decides how much). */
  summary: string;
  ledgerRef: string;
  /** Present when the gate refused or an approval was denied — the model must adapt. */
  gate?: { decision: "refuse" | "denied"; reason: string };
}

export interface ModelInput {
  request: string;
  skillInstructions: string;
  tools: ToolDescriptor[];
  history: HistoryItem[];
  /** Verifier gaps from a previous attempt, if the loop is giving the model one more round. */
  gaps?: string[];
}

export interface ModelClient {
  readonly model: string;
  readonly promptVersion: string;
  /** Initial outline. Recorded as the `plan` event. */
  plan(input: ModelInput): Promise<{ steps: string[]; usage: ModelUsage }>;
  /** Next action. Recorded as an `inference` event (one per call, `toolName: null` for goal reached). */
  decide(input: ModelInput): Promise<ModelDecision>;
}

/**
 * Replays a fixed script of decisions. Used for fixtures and tests; throws if the
 * loop asks for more decisions than scripted (that is a test failure, not a stop rule).
 */
export class ScriptedModel implements ModelClient {
  readonly model: string;
  readonly promptVersion: string;
  private i = 0;
  readonly inputs: ModelInput[] = [];

  constructor(
    private readonly script: {
      plan: { steps: string[]; usage: ModelUsage };
      decisions: ModelDecision[];
    },
    opts: { model?: string; promptVersion?: string } = {},
  ) {
    this.model = opts.model ?? "scripted-model";
    this.promptVersion = opts.promptVersion ?? "aqa-prompt-v0.1.0";
  }

  async plan(_input: ModelInput) {
    return this.script.plan;
  }

  async decide(input: ModelInput): Promise<ModelDecision> {
    this.inputs.push(input);
    const d = this.script.decisions[this.i++];
    if (!d) throw new Error(`ScriptedModel: no decision scripted for cycle ${this.i}`);
    return d;
  }
}
