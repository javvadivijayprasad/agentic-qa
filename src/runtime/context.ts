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

export interface ContextCaps {
  /** Token budget for primary-source observations. */
  sources: number;
  /** Token budget for the remaining step-by-step history. */
  history: number;
}

export const DEFAULT_CAPS: ContextCaps = { sources: 60_000, history: 40_000 };

export interface OrderedContextOptions {
  /**
   * Tools whose observations are PRIMARY SOURCES — the story text, a file the
   * agent read, a parsed feature. These are ordered ahead of the step history
   * and trimmed last, because a model that has lost the acceptance criteria
   * starts inventing them, while one that has lost its own earlier chatter
   * merely repeats a step.
   */
  sourceTools?: string[];
  caps?: Partial<ContextCaps>;
}

/**
 * Production context assembly (design §6): source-first ordering with a token
 * cap per category.
 *
 * Three rules, in priority order:
 *  1. tool schemas are never trimmed — a model missing a schema invents one;
 *  2. primary sources come first and are trimmed last;
 *  3. gate feedback (refused / denied) is never trimmed at any size, because
 *     dropping it makes the model propose the refused call again, which the
 *     gate refuses again, until the step budget runs out.
 */
export class OrderedContextBuilder implements ContextBuilder {
  private readonly sourceTools: Set<string>;
  private readonly caps: ContextCaps;

  constructor(opts: OrderedContextOptions = {}) {
    this.sourceTools = new Set(opts.sourceTools ?? []);
    this.caps = { ...DEFAULT_CAPS, ...opts.caps };
  }

  build(parts: {
    request: string;
    skillInstructions: string;
    tools: ToolDescriptor[];
    history: HistoryItem[];
    gaps?: string[];
  }) {
    const isSource = (h: HistoryItem): boolean => this.sourceTools.has(h.toolName) && h.ok;
    const sources = parts.history.filter(isSource);
    const steps = parts.history.filter((h) => !isSource(h));

    const keptSources = takeWhileUnderCap(sources, this.caps.sources);
    const keptSteps = takeNewestUnderCap(steps, this.caps.history);
    const dropped = sources.length - keptSources.length + (steps.length - keptSteps.length);

    const input: ModelInput = {
      request: parts.request,
      skillInstructions: parts.skillInstructions,
      tools: parts.tools,
      history: [...keptSources, ...keptSteps],
    };
    if (parts.gaps && parts.gaps.length > 0) input.gaps = parts.gaps;

    const sectionText: Array<[string, string, number?]> = [
      ["instructions", parts.skillInstructions],
      ["request", parts.request],
      ["tool_schemas", JSON.stringify(parts.tools)],
      ["sources", JSON.stringify(keptSources), sources.length - keptSources.length],
      ["history", JSON.stringify(keptSteps), steps.length - keptSteps.length],
    ];
    if (input.gaps) sectionText.push(["gaps", JSON.stringify(input.gaps)]);

    const sections = sectionText.map(([name, text, drop]) => ({
      name,
      sha256: sha256(text),
      tokens: estimateTokens(text),
      ...(drop ? { dropped: drop } : {}),
    }));
    return {
      input,
      event: {
        sections,
        totalTokens: sections.reduce((n, s) => n + s.tokens, 0),
        ...(dropped > 0 ? { droppedItems: dropped } : {}),
      } as ContextPayload,
    };
  }
}

function itemTokens(h: HistoryItem): number {
  return estimateTokens(JSON.stringify(h));
}

/** Oldest-first, keep until the cap is reached. */
function takeWhileUnderCap(items: HistoryItem[], cap: number): HistoryItem[] {
  const out: HistoryItem[] = [];
  let used = 0;
  for (const h of items) {
    const t = itemTokens(h);
    if (used + t > cap) break;
    out.push(h);
    used += t;
  }
  return out;
}

/**
 * Newest-first selection, returned in chronological order. Gate feedback is
 * always kept, whatever the cap.
 */
function takeNewestUnderCap(items: HistoryItem[], cap: number): HistoryItem[] {
  const keep = new Set<HistoryItem>();
  let used = 0;
  for (const h of items) {
    if (!h.gate) continue;
    keep.add(h);
    used += itemTokens(h);
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const h = items[i] as HistoryItem;
    if (keep.has(h)) continue;
    const t = itemTokens(h);
    if (used + t > cap) continue;
    keep.add(h);
    used += t;
  }
  return items.filter((h) => keep.has(h));
}

/** Compact a tool result into the one line the model sees next cycle. */
export function compactResult(result: unknown, max = 400): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text === undefined) return "";
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
