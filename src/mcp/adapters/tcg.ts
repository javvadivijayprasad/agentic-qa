import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface TcgOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * In-process `tcg` adapter: the platform's test-case generator service.
 *
 * `TCG_URL` is the FULL endpoint to POST to, not a base URL — the platform
 * owns its routing and we do not invent a path. The request body is
 * `{ story, acceptanceCriteria, count }`; the response may be `{ cases: [...] }`
 * or a bare array, and is passed through to the model unchanged apart from
 * that unwrapping. This tool has no side effects, so it is classed `read`;
 * note in review that it does send story text to that service.
 */
export class TcgTools implements ToolClient {
  readonly server = "tcg";
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: string,
    opts: TcgOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "generate_cases",
        description:
          "Ask the test-case generator service for candidate test cases for a user story and its acceptance criteria. Returns candidates only — nothing is written anywhere.",
        inputSchema: {
          type: "object",
          properties: {
            story: { type: "string", description: "Story title and description" },
            acceptanceCriteria: {
              type: "array",
              items: { type: "string" },
              description: "One entry per acceptance criterion",
            },
            count: { type: "integer", description: "Maximum number of cases to return" },
          },
          required: ["story"],
        },
        policyClass: "read",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "generate_cases")
      return fail(`unknown tcg tool: ${server}.${name}`);
    if (typeof args["story"] !== "string" || !args["story"]) return fail(`"story" is required`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          story: args["story"],
          acceptanceCriteria: args["acceptanceCriteria"] ?? [],
          ...(typeof args["count"] === "number" ? { count: args["count"] } : {}),
        }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) return fail(`test-case generator returned ${res.status}: ${text.slice(0, 500)}`);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return fail(`test-case generator returned non-JSON: ${text.slice(0, 200)}`);
      }
      const cases = Array.isArray(body)
        ? body
        : ((body as { cases?: unknown }).cases ?? (body as { testCases?: unknown }).testCases);
      if (!Array.isArray(cases)) return fail(`test-case generator response had no "cases" array`);
      return { ok: true, result: { cases, count: cases.length }, artefacts: [] };
    } catch (e) {
      const err = e as Error;
      return fail(
        err.name === "AbortError"
          ? `test-case generator timed out after ${this.timeoutMs} ms`
          : err.message,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
