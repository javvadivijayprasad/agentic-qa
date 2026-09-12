import { sha256 } from "../ledger/ledger.js";
import type { ContextPayload } from "../types.js";
import type { HistoryItem, ModelInput } from "./model.js";
import type { ToolDescriptor } from "./tools.js";

/**
 * Builds the model input for one cycle and the `context` ledger event that
 * describes it (hashes + token counts only — never content).
 *
 * A2 keeps this simple: full instructions, full tool schemas, and one compacted
 * line per prior observation. A6 adds per-category token caps and the
 * source-first ordering from design §6.
 */
export interface ContextBuilder {
  build(parts: {
    request: string;
    skillInstructions: string;
    tools: ToolDescriptor[];
    history: HistoryItem[];
    gaps?: string[];
  }): { input: ModelInput; event: ContextPayload };
}

/** Rough token estimate (4 chars ≈ 1 token). Replaced by real usage from the model adapter. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class BasicContextBuilder implements ContextBuilder {
  build(parts: {
    request: string;
    skillInstructions: string;
    tools: ToolDescriptor[];
    history: HistoryItem[];
    gaps?: string[];
  }) {
    const input: ModelInput = {
      request: parts.request,
      skillInstructions: parts.skillInstructions,
      tools: parts.tools,
      history: parts.history,
    };
    if (parts.gaps && parts.gaps.length > 0) input.gaps = parts.gaps;

    const sectionText: Array<[string, string]> = [
      ["instructions", parts.skillInstructions],
      ["request", parts.request],
      ["tool_schemas", JSON.stringify(parts.tools)],
      ["history", JSON.stringify(parts.history)],
    ];
    if (input.gaps) sectionText.push(["gaps", JSON.stringify(input.gaps)]);

    const sections = sectionText.map(([name, text]) => ({
      name,
      sha256: sha256(text),
      tokens: estimateTokens(text),
    }));
    const event: ContextPayload = {
      sections,
      totalTokens: sections.reduce((n, s) => n + s.tokens, 0),
    };
    return { input, event };
  }
}

/** Compact a tool result into the one line the model sees next cycle. */
export function compactResult(result: unknown, max = 400): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text === undefined) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
