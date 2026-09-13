import { describe, it, expect } from "vitest";
import {
  AnthropicModel,
  RUNTIME_SYSTEM,
  normaliseSchema,
  parseSteps,
  renderCycle,
  toWireName,
  fromWireName,
  wireTools,
  type MessageRequest,
  type MessageResponse,
  type MessagesApi,
} from "../src/runtime/anthropic.js";
import type { HistoryItem, ModelInput } from "../src/runtime/model.js";
import type { ToolDescriptor } from "../src/runtime/tools.js";

const witWorkItem: ToolDescriptor = {
  server: "ado",
  name: "wit_work_item",
  description: "Retrieve work item data.",
  inputSchema: { type: "object", properties: { action: {}, id: {} }, required: ["action"] },
  policyClass: "write_record",
  actionArg: "action",
  actions: {
    get: { policyClass: "read", scopeArgs: { workItem: "id" } },
    list_comments: { policyClass: "read", scopeArgs: { workItem: "workItemId" } },
  },
};

const readFile: ToolDescriptor = {
  server: "fs",
  name: "read_file",
  description: "Read a file.",
  inputSchema: { type: "object", properties: { path: {} } },
  policyClass: "read",
};

function fakeApi(responses: MessageResponse[]): MessagesApi & { sent: MessageRequest[] } {
  let i = 0;
  const sent: MessageRequest[] = [];
  return {
    sent,
    async create(body: MessageRequest) {
      sent.push(body);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (!r) throw new Error("no scripted response");
      return r;
    },
  };
}

const model = (api: MessagesApi, over = {}) =>
  new AnthropicModel({ apiKey: "sk-ant-test", factory: async () => api, ...over });

const input = (over: Partial<ModelInput> = {}): ModelInput => ({
  request: "Write tests for AB#1",
  skillInstructions: "SKILL INSTRUCTIONS",
  tools: [witWorkItem, readFile],
  history: [],
  ...over,
});

describe("wire names", () => {
  it("maps the qualified name to a legal API tool name and back", () => {
    expect(toWireName("ado.wit_work_item")).toBe("ado__wit_work_item");
    expect(fromWireName("ado__wit_work_item")).toBe("ado.wit_work_item");
    // the API only accepts ^[a-zA-Z0-9_-]{1,128}$ — our dotted names would be rejected
    for (const t of wireTools([witWorkItem, readFile]).tools) {
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });

  it("tells the model which actions are permitted and which arguments are scope-checked", () => {
    const { tools } = wireTools([witWorkItem]);
    const d = tools[0]!.description;
    expect(d).toContain("Retrieve work item data.");
    expect(d).toContain('"get" (read)');
    expect(d).toContain('"list_comments" (read)');
    expect(d).toContain("Any other action is refused");
    expect(d).toContain("Scope-checked argument(s): id, workItemId");
  });

  it("states the class for a tool that does not multiplex", () => {
    expect(wireTools([readFile]).tools[0]!.description).toContain("Governance class: read.");
  });
});

describe("normaliseSchema", () => {
  it("passes object schemas through and repairs anything else", () => {
    const ok = { type: "object", properties: { a: {} } };
    expect(normaliseSchema(ok)).toBe(ok);
    expect(normaliseSchema({})).toEqual({ type: "object", properties: {} });
    expect(normaliseSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(normaliseSchema({ properties: { b: {} } })).toEqual({
      type: "object",
      properties: { b: {} },
    });
  });
});

describe("AnthropicModel.decide", () => {
  it("maps tool_use blocks back to qualified names and reports usage", async () => {
    const api = fakeApi([
      {
        content: [
          { type: "text", text: "Reading the story first." },
          {
            type: "tool_use",
            id: "t1",
            name: "ado__wit_work_item",
            input: { action: "get", id: 1 },
          },
          { type: "tool_use", id: "t2", name: "fs__read_file", input: { path: "a.txt" } },
        ],
        usage: { input_tokens: 120, output_tokens: 45 },
      },
    ]);
    const d = await model(api).decide(input());
    expect(d.calls).toEqual([
      { toolName: "ado.wit_work_item", args: { action: "get", id: 1 } },
      { toolName: "fs.read_file", args: { path: "a.txt" } },
    ]);
    expect(d.note).toBe("Reading the story first.");
    expect(d.usage).toEqual({ inputTokens: 120, outputTokens: 45 });
  });

  it("treats a reply with no tool calls as 'goal reached', keeping the text as the note", async () => {
    const api = fakeApi([
      { content: [{ type: "text", text: "All four cases created." }], usage: {} },
    ]);
    const d = await model(api).decide(input());
    expect(d.calls).toEqual([]);
    expect(d.note).toBe("All four cases created.");
    expect(d.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("drops an invented tool name and warns rather than passing it to the gate", async () => {
    const warnings: string[] = [];
    const api = fakeApi([
      {
        content: [
          { type: "tool_use", id: "t1", name: "ado__delete_everything", input: {} },
          { type: "tool_use", id: "t2", name: "fs__read_file", input: { path: "a" } },
        ],
      },
    ]);
    const d = await model(api, { warn: (m: string) => warnings.push(m) }).decide(input());
    expect(d.calls.map((c) => c.toolName)).toEqual(["fs.read_file"]);
    expect(warnings[0]).toMatch(/unknown tool "ado__delete_everything"/);
  });

  it("sends the runtime system prompt ahead of the skill's, and only the allowed tools", async () => {
    const api = fakeApi([{ content: [] }]);
    await model(api).decide(input());
    const sent = api.sent[0]!;
    expect(sent.system.indexOf(RUNTIME_SYSTEM)).toBe(0);
    expect(sent.system).toContain("SKILL INSTRUCTIONS");
    expect(sent.tools?.map((t) => t.name)).toEqual(["ado__wit_work_item", "fs__read_file"]);
    expect(sent.tool_choice).toEqual({ type: "auto" });
  });

  it("scrubs secrets out of everything it sends", async () => {
    const api = fakeApi([{ content: [] }]);
    const leaky = input({
      request: "use AZURE_DEVOPS_PAT=abcdefghijklmnop to read AB#1",
      skillInstructions: "key sk-ant-abcdefghijklmnop12345",
      history: [
        {
          toolName: "fs.read_file",
          ok: true,
          summary: "Bearer abcdefghijklmnopqrst",
          ledgerRef: "e1",
        },
      ],
    });
    await model(api).decide(leaky);
    const sent = api.sent[0]!;
    const all = sent.system + JSON.stringify(sent.messages);
    expect(all).not.toContain("abcdefghijklmnop12345");
    expect(all).not.toContain("Bearer abcdefghijklmnopqrst");
    expect(all).toContain("[REDACTED]");
  });

  it("connects once and reuses the client", async () => {
    let built = 0;
    const api = fakeApi([{ content: [] }]);
    const m = new AnthropicModel({
      apiKey: "k",
      factory: async () => (built++, api),
    });
    await m.decide(input());
    await m.decide(input());
    expect(built).toBe(1);
  });

  it("refuses to construct without an API key", () => {
    expect(() => new AnthropicModel({ apiKey: "" })).toThrow(/API key/);
  });
});

describe("AnthropicModel.plan", () => {
  it("asks for an outline with no tools attached, and parses the steps", async () => {
    const api = fakeApi([
      {
        content: [
          {
            type: "text",
            text: "Here is the plan:\n1. Read AB#1\n2. Write the feature\n3. Run it",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ]);
    const p = await model(api).plan(input());
    expect(p.steps).toEqual(["Read AB#1", "Write the feature", "Run it"]);
    expect(p.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(api.sent[0]!.tools).toBeUndefined();
    expect(api.sent[0]!.messages[0]!.content).toContain("Do not call any tools yet");
  });
});

describe("parseSteps", () => {
  it("reads numbered, bulleted, or plain lines", () => {
    expect(parseSteps("1. one\n2) two")).toEqual(["one", "two"]);
    expect(parseSteps("- a\n* b")).toEqual(["a", "b"]);
    expect(parseSteps("just a sentence")).toEqual(["just a sentence"]);
    expect(parseSteps("")).toEqual([]);
  });
});

describe("renderCycle", () => {
  const src = (over: Partial<HistoryItem>): HistoryItem => ({
    toolName: "ado.wit_work_item",
    ok: true,
    summary: "AC-1 …",
    ledgerRef: "e7",
    ...over,
  });

  it("puts sources under their own heading, using the flag context assembly set", () => {
    const text = renderCycle(
      input({
        history: [
          src({ source: true, summary: "the story text" }),
          src({ toolName: "pw.run_tests", summary: "4 passed" }),
        ],
      }),
    );
    expect(text.indexOf("# Sources already read")).toBeLessThan(
      text.indexOf("# What has happened so far"),
    );
    expect(text).toContain("the story text");
    expect(text).toContain("4 passed");
  });

  it("shows a refusal as the gate's decision and reason, not as a result", () => {
    const text = renderCycle(
      input({
        history: [
          src({
            toolName: "ado.wit_work_item_write",
            ok: false,
            summary: "ignored",
            gate: { decision: "refuse", reason: "not in the governance manifest" },
          }),
        ],
      }),
    );
    expect(text).toContain("REFUSE: not in the governance manifest");
    expect(text).not.toContain("ignored");
  });

  it("presents verifier gaps as a last attempt", () => {
    const text = renderCycle(input({ gaps: ["suite-not-green: 6 skipped"] }));
    expect(text).toContain("The verifier rejected the run");
    expect(text).toContain("this is your last attempt");
    expect(text).toContain("suite-not-green: 6 skipped");
  });

  it("always ends by asking for the next action", () => {
    expect(renderCycle(input()).trimEnd()).toMatch(
      /no tool calls if you believe the goal is reached\.$/,
    );
  });
});
