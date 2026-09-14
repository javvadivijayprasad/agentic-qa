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
    notes?: string[];
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
    notes?: string[];
  }) {
    const input: ModelInput = {
      request: parts.request,
      skillInstructions: parts.skillInstructions,
      tools: parts.tools,
      history: parts.history,
    };
    if (parts.gaps && parts.gaps.length > 0) input.gaps = parts.gaps;
    if (parts.notes && parts.notes.length > 0) input.notes = parts.notes;

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

/** How many of the model's own recent notes are carried forward. */
export const NOTE_WINDOW = 4;

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
    notes?: string[];
  }) {
    const isSource = (h: HistoryItem): boolean => this.sourceTools.has(h.toolName) && h.ok;
    // The same file read twice is one source, not two. Without this, a model
    // that repeats a read pays for the content again every cycle and crowds out
    // everything else.
    const sources = dedupe(parts.history.filter(isSource));
    const steps = parts.history.filter((h) => !isSource(h));

    const keptSources = takeWhileUnderCap(sources, this.caps.sources).map((h) => ({
      ...h,
      source: true,
    }));
    const keptSteps = takeNewestUnderCap(steps, this.caps.history);
    const dropped = sources.length - keptSources.length + (steps.length - keptSteps.length);

    const input: ModelInput = {
      request: parts.request,
      skillInstructions: parts.skillInstructions,
      tools: parts.tools,
      history: [...keptSources, ...keptSteps],
    };
    if (parts.gaps && parts.gaps.length > 0) input.gaps = parts.gaps;
    // Only the most recent few: older reasoning is superseded by what actually
    // happened, which is already in the history.
    if (parts.notes && parts.notes.length > 0) input.notes = parts.notes.slice(-NOTE_WINDOW);

    const sectionText: Array<[string, string, number?]> = [
      ["instructions", parts.skillInstructions],
      ["request", parts.request],
      ["tool_schemas", JSON.stringify(parts.tools)],
      ["sources", JSON.stringify(keptSources), sources.length - keptSources.length],
      ["history", JSON.stringify(keptSteps), steps.length - keptSteps.length],
    ];
    if (input.notes) sectionText.push(["notes", JSON.stringify(input.notes)]);
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

/** Drop later items identical in tool and content, keeping the first. */
function dedupe(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  return items.filter((h) => {
    const key = `${h.toolName}\u0000${h.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

/**
 * How much of an observation the model gets to see.
 *
 * These are deliberately generous. A2 used 400 characters for everything,
 * which is fine for "4 passed, 1 failed" and catastrophic for a work item: an
 * Azure DevOps response spends its first few hundred characters on a content
 * banner and system fields, so the acceptance criteria — the whole point of
 * the call — fell outside the window. The agent then re-read the same work
 * item until a stop rule killed the run, and said so in its notes each time.
 * Aggregate size is controlled by the context caps, which trim whole items;
 * this only decides how much of ONE observation survives.
 */
export const SOURCE_CHARS = 16_000;
export const STEP_CHARS = 2_000;

/**
 * Compact a tool result for the model. When something IS cut, say so and give
 * the true size, so the model can tell the difference between "this is all
 * there is" and "there is more, but not for you" — the second is a reason to
 * ask differently, never a reason to ask again.
 */
export function compactResult(result: unknown, max = STEP_CHARS): string {
  const text = typeof result === "string" ? result : JSON.stringify(result);
  if (text === undefined) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated: ${text.length} characters total, ${
    text.length - max
  } not shown. Re-reading returns the same truncation — narrow the request instead.]`;
}
