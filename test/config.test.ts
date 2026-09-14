import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  agentConfigFromObject,
  loadAgentConfig,
  loadDotEnv,
  orgNameFromUrl,
  readRuntimeEnv,
} from "../src/config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-cfg-"));

const good = {
  agent: {
    model: "claude-sonnet-4-6",
    prompt_version: "aqa-prompt-v0.1.0",
    budgets: { steps: 40, tokens: 400000 },
    scope: {
      work_items: ["1"],
      repos: ["orders-web"],
      test_plans: ["Sandbox Plan"],
      branches_writable: ["agent/*"],
    },
    policy: { write_record: "ask", destructive: "refuse" },
  },
};

describe("agentConfigFromObject", () => {
  it("parses a full config and applies default policy for unspecified classes", () => {
    const c = agentConfigFromObject(good);
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.budgets).toEqual({ steps: 40, tokens: 400000 });
    expect(c.scope.test_plans).toEqual(["Sandbox Plan"]);
    expect(c.policy).toEqual({
      read: "execute",
      write_workspace: "execute",
      write_branch: "ask",
      write_record: "ask",
      destructive: "refuse",
    });
  });

  it("applies defaults for model, prompt_version and budgets", () => {
    const c = agentConfigFromObject({ agent: { scope: { work_items: [1] } } });
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.prompt_version).toBe("aqa-prompt-v0.1.0");
    expect(c.budgets).toEqual({ steps: 40, tokens: 400000 });
    expect(c.scope.work_items).toEqual(["1"]); // numbers coerced to strings
    expect(c.scope.repos).toEqual([]);
  });

  it("rejects missing agent section, missing scope, bad policy values, unknown classes, bad budgets", () => {
    expect(() => agentConfigFromObject({})).toThrow(/missing "agent:"/);
    expect(() => agentConfigFromObject({ agent: {} })).toThrow(/agent.scope is required/);
    expect(() =>
      agentConfigFromObject({ agent: { scope: {}, policy: { read: "maybe" } } }),
    ).toThrow(/must be execute \| ask \| refuse/);
    expect(() =>
      agentConfigFromObject({ agent: { scope: {}, policy: { delete: "refuse" } } }),
    ).toThrow(/unknown class "delete"/);
    expect(() => agentConfigFromObject({ agent: { scope: {}, budgets: { steps: 0 } } })).toThrow(
      /positive integer/,
    );
    expect(() => agentConfigFromObject({ agent: { scope: { repos: "x" } } })).toThrow(
      /list of strings/,
    );
    expect(() => agentConfigFromObject("nope")).toThrow(ConfigError);
  });
});

describe("loadAgentConfig", () => {
  it("loads JSON", async () => {
    const f = join(tmp(), "c.json");
    writeFileSync(f, JSON.stringify(good));
    expect((await loadAgentConfig(f)).scope.repos).toEqual(["orders-web"]);
  });

  it("loads YAML (the ai-quality.config.yaml shape)", async () => {
    const f = join(tmp(), "ai-quality.config.yaml");
    writeFileSync(
      f,
      `# fleet-wide config
agent:
  model: claude-sonnet-4-6
  budgets: { steps: 12, tokens: 1000 }
  scope:
    work_items: ["1", "100-199"]
    repos: [orders-web]
    test_plans: ["Sandbox Plan"]
    branches_writable: ["agent/*"]
  policy:
    write_record: refuse
`,
    );
    const c = await loadAgentConfig(f);
    expect(c.budgets.steps).toBe(12);
    expect(c.scope.work_items).toEqual(["1", "100-199"]);
    expect(c.policy.write_record).toBe("refuse");
  });

  it("errors clearly on a missing file", async () => {
    await expect(loadAgentConfig(join(tmp(), "missing.yaml"))).rejects.toThrow(/not found/);
  });
});

describe("loadDotEnv", () => {
  it("loads KEY=value lines, strips quotes, skips comments, never overrides existing", () => {
    const f = join(tmp(), ".env");
    writeFileSync(f, `# comment\nA=1\nB="two words"\nC='x'\nEXISTING=new\n\nbad line\n`);
    const env: NodeJS.ProcessEnv = { EXISTING: "old" };
    const loaded = loadDotEnv(f, env);
    expect(loaded.sort()).toEqual(["A", "B", "C"]);
    expect(env).toEqual({ EXISTING: "old", A: "1", B: "two words", C: "x" });
  });
  it("fills in a defined-but-EMPTY ambient variable, which would otherwise shadow the file", () => {
    const f = join(tmp(), ".env");
    writeFileSync(f, "ANTHROPIC_API_KEY=sk-ant-real\nOTHER=x\n");
    const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "" };
    expect(loadDotEnv(f, env).sort()).toEqual(["ANTHROPIC_API_KEY", "OTHER"]);
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-real");
  });

  it("returns [] when the file is absent", () => {
    expect(loadDotEnv(join(tmp(), "nope"), {})).toEqual([]);
  });
});

describe("readRuntimeEnv", () => {
  it("requires ANTHROPIC_API_KEY unless told otherwise", () => {
    expect(() => readRuntimeEnv({})).toThrow(/ANTHROPIC_API_KEY/);
    expect(readRuntimeEnv({}, { requireAnthropic: false }).azureDevOps).toBeUndefined();
  });
  it("derives the ADO org from the URL and requires PAT + project when the URL is set", () => {
    const base = {
      ANTHROPIC_API_KEY: "k",
      AZURE_DEVOPS_ORG_URL: "https://dev.azure.com/jvijayprasad",
    };
    expect(() => readRuntimeEnv({ ...base })).toThrow(/AZURE_DEVOPS_PAT/);
    expect(() => readRuntimeEnv({ ...base, AZURE_DEVOPS_PAT: "p" })).toThrow(
      /AZURE_DEVOPS_PROJECT/,
    );
    const r = readRuntimeEnv({
      ...base,
      AZURE_DEVOPS_PAT: "p",
      AZURE_DEVOPS_PROJECT: "agentic-qa-sandbox",
      AQA_SANDBOX: "1",
    });
    expect(r.azureDevOps).toEqual({
      orgUrl: base.AZURE_DEVOPS_ORG_URL,
      org: "jvijayprasad",
      pat: "p",
      project: "agentic-qa-sandbox",
    });
    expect(r.sandbox).toBe(true);
  });
});

describe("orgNameFromUrl", () => {
  it("handles both Azure DevOps URL shapes", () => {
    expect(orgNameFromUrl("https://dev.azure.com/jvijayprasad")).toBe("jvijayprasad");
    expect(orgNameFromUrl("https://dev.azure.com/jvijayprasad/")).toBe("jvijayprasad");
    expect(orgNameFromUrl("https://myorg.visualstudio.com")).toBe("myorg");
    expect(() => orgNameFromUrl("https://dev.azure.com/")).toThrow(/no organisation segment/);
    expect(() => orgNameFromUrl("https://example.com/x")).toThrow(/not a recognised/);
  });
});

describe("agent.capabilities", () => {
  it("defaults to the environment being fully capable", () => {
    expect(agentConfigFromObject(good).capabilities).toEqual({ test_plans: true });
  });

  it("turns off test plans when the account has no Test Plans access level", () => {
    const c = agentConfigFromObject({
      agent: { ...good.agent, capabilities: { test_plans: false } },
    });
    expect(c.capabilities.test_plans).toBe(false);
  });

  it("rejects a non-boolean and an unknown capability", () => {
    expect(() =>
      agentConfigFromObject({ agent: { ...good.agent, capabilities: { test_plans: "no" } } }),
    ).toThrow(/must be true or false/);
    expect(() =>
      agentConfigFromObject({ agent: { ...good.agent, capabilities: { nope: true } } }),
    ).toThrow(/unknown key/);
  });
});
