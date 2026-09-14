import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CompositeTools,
  McpToolClient,
  normaliseResult,
  type McpSession,
  type ServerSpec,
  type SessionFactory,
} from "../src/mcp/client.js";
import { FsTools } from "../src/mcp/adapters/fs.js";
import { buildReport, renderReportMarkdown } from "../src/mcp/discover.js";
import { DEFAULT_MANIFEST, classify, type Manifest } from "../src/mcp/manifest.js";
import { azureDevOpsServer, playwrightServer, originsOf } from "../src/mcp/servers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aqa-mcp-"));

function fakeSession(
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>,
  onCall: (name: string, args: Record<string, unknown>) => unknown = () => ({ content: [] }),
): McpSession & { closed: boolean; calls: string[] } {
  const s = {
    closed: false,
    calls: [] as string[],
    async listTools() {
      return { tools: tools.map((t) => ({ ...t, inputSchema: t.inputSchema ?? {} })) };
    },
    async callTool(p: { name: string; arguments: Record<string, unknown> }) {
      s.calls.push(p.name);
      return onCall(p.name, p.arguments) as never;
    },
    async close() {
      s.closed = true;
    },
  };
  return s;
}

const specs: ServerSpec[] = [
  { name: "ado", command: "npx", args: ["x"] },
  { name: "playwright", command: "npx", args: ["y"] },
];

describe("McpToolClient", () => {
  it("connects each server once, qualifies tools, and classifies via the manifest (unknown → destructive)", async () => {
    const sessions: Record<string, ReturnType<typeof fakeSession>> = {
      ado: fakeSession([{ name: "wit_get_work_item", description: "Get a work item" }]),
      playwright: fakeSession([{ name: "browser_navigate" }]),
    };
    let created = 0;
    const factory: SessionFactory = async (spec) => (created++, sessions[spec.name]!);
    const manifest: Manifest = {
      "ado.wit_get_work_item": { policyClass: "read", scopeArgs: { workItem: "id" } },
    };
    const c = new McpToolClient(specs, manifest, factory);
    const tools = await c.listTools();
    await c.listTools(); // second call must not reconnect
    expect(created).toBe(2);
    expect(tools.map((t) => `${t.server}.${t.name}`).sort()).toEqual([
      "ado.wit_get_work_item",
      "playwright.browser_navigate",
    ]);
    const ado = tools.find((t) => t.server === "ado")!;
    expect(ado.policyClass).toBe("read");
    expect(ado.scopeArgs).toEqual({ workItem: "id" });
    expect(ado.description).toBe("Get a work item");
    expect(tools.find((t) => t.server === "playwright")!.policyClass).toBe("destructive");
  });

  it("routes calls to the right server and normalises results; errors become ok:false", async () => {
    const ado = fakeSession([{ name: "t" }], (name, args) =>
      name === "t" && args["boom"]
        ? { isError: true, content: [{ type: "text", text: "kaboom" }] }
        : { content: [{ type: "text", text: JSON.stringify({ id: 1, title: "x" }) }] },
    );
    const c = new McpToolClient([specs[0]!], {}, async () => ado);
    expect(await c.call("ado", "t", {})).toEqual({
      ok: true,
      result: { id: 1, title: "x" },
      artefacts: [],
    });
    expect(await c.call("ado", "t", { boom: 1 })).toEqual({
      ok: false,
      result: { message: "kaboom" },
      artefacts: [],
    });
    expect((await c.call("nope", "t", {})).ok).toBe(false);
    expect(ado.calls).toEqual(["t", "t"]);
  });

  it("a throwing session becomes ok:false, and close() closes every session", async () => {
    const a = fakeSession([{ name: "t" }], () => {
      throw new Error("transport died");
    });
    const b = fakeSession([]);
    const c = new McpToolClient(specs, {}, async (s) => (s.name === "ado" ? a : b));
    const r = await c.call("ado", "t", {});
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.result)).toContain("transport died");
    await c.close();
    expect(a.closed && b.closed).toBe(true);
  });

  it("rejects duplicate server names", () => {
    expect(() => new McpToolClient([specs[0]!, specs[0]!], {})).toThrow(/duplicate/);
  });
});

describe("normaliseResult", () => {
  it("prefers structuredContent, parses JSON text, joins plain text, keeps raw blocks otherwise", () => {
    expect(normaliseResult({ structuredContent: { a: 1 }, content: [] })).toEqual({ a: 1 });
    expect(normaliseResult({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
    expect(normaliseResult({ content: [{ type: "text", text: "[1,2]" }] })).toEqual([1, 2]);
    expect(
      normaliseResult({
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("hello\nworld");
    expect(normaliseResult({ content: [{ type: "image", data: "…" }] })).toEqual([
      { type: "image", data: "…" },
    ]);
    expect(normaliseResult({ isError: true, content: [{ type: "text", text: "bad" }] })).toEqual({
      message: "bad",
    });
    expect(normaliseResult({})).toBeNull();
  });
});

describe("CompositeTools", () => {
  it("merges tool lists and routes by server", async () => {
    const ws = tmp();
    writeFileSync(join(ws, "a.txt"), "hi");
    const mcp = new McpToolClient([specs[0]!], {}, async () =>
      fakeSession([{ name: "t" }], () => ({ content: [{ type: "text", text: "ok" }] })),
    );
    const all = new CompositeTools([mcp, new FsTools(ws)]);
    const names = (await all.listTools()).map((t) => `${t.server}.${t.name}`).sort();
    expect(names).toEqual(["ado.t", "fs.list_dir", "fs.read_file", "fs.write_file"]);
    expect((await all.call("fs", "read_file", { path: "a.txt" })).result).toEqual({
      path: "a.txt",
      content: "hi",
    });
    expect((await all.call("ado", "t", {})).result).toBe("ok");
    expect((await all.call("zzz", "t", {})).ok).toBe(false);
  });
});

describe("FsTools", () => {
  it("reads, lists and writes inside the workspace; refuses escapes", async () => {
    const ws = tmp();
    const fs = new FsTools(ws);
    mkdirSync(join(ws, "features"));
    writeFileSync(join(ws, "features", "a.feature"), "Feature: A");
    expect((await fs.call("fs", "list_dir", {})).result).toEqual({
      path: ".",
      entries: [{ name: "features", type: "dir" }],
    });
    expect((await fs.call("fs", "read_file", { path: "features/a.feature" })).result).toEqual({
      path: "features/a.feature",
      content: "Feature: A",
    });
    const w = await fs.call("fs", "write_file", { path: "tests/new.spec.ts", content: "x" });
    expect(w.ok).toBe(true);
    expect(w.artefacts).toEqual(["tests/new.spec.ts"]);
    expect(existsSync(join(ws, "tests", "new.spec.ts"))).toBe(true);

    for (const bad of ["../outside.txt", "../../etc/passwd", "/etc/passwd"]) {
      const r = await fs.call("fs", "read_file", { path: bad });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r.result)).toMatch(/escapes the workspace|no such file/);
    }
    expect((await fs.call("fs", "write_file", { path: "../x", content: "y" })).ok).toBe(false);
    expect(existsSync(join(ws, "..", "x"))).toBe(false);
  });

  it("descriptors carry the right classes", async () => {
    const t = await new FsTools(tmp()).listTools();
    expect(Object.fromEntries(t.map((d) => [d.name, d.policyClass]))).toEqual({
      read_file: "read",
      list_dir: "read",
      write_file: "write_workspace",
    });
  });
});

describe("manifest", () => {
  it("classifies known fs tools and defaults unknown to destructive", () => {
    expect(classify("fs.read_file").policyClass).toBe("read");
    expect(classify("fs.write_file").policyClass).toBe("write_workspace");
    expect(classify("ado.anything").policyClass).toBe("destructive");
    expect(DEFAULT_MANIFEST["ado.wit_get_work_item"]).toBeUndefined(); // filled in A5 from discovery
  });
});

describe("server specs", () => {
  it("builds the Azure DevOps spec from env without leaking the PAT into args", () => {
    const spec = azureDevOpsServer({
      anthropicApiKey: "k",
      sandbox: false,
      azureDevOps: {
        orgUrl: "https://dev.azure.com/jvijayprasad",
        org: "jvijayprasad",
        pat: "SECRETPAT",
        project: "p",
      },
    });
    expect(spec.name).toBe("ado");
    expect(spec.args.join(" ")).toContain("@azure-devops/mcp");
    expect(spec.args).toContain("jvijayprasad");
    // the documented headless method: a PAT from ADO_MCP_AUTH_TOKEN. Without
    // this flag the server defaults to interactive OAuth and opens a browser.
    expect(spec.args.join(" ")).toContain("--authentication envvar");
    expect(spec.args.join(" ")).not.toContain("SECRETPAT");
    expect(spec.env?.["ADO_MCP_AUTH_TOKEN"]).toBe("SECRETPAT");
    // nothing else carries the token
    expect(Object.entries(spec.env ?? {}).filter(([, v]) => v === "SECRETPAT").length).toBe(1);
  });
  it("playwright spec is headless by default", () => {
    expect(playwrightServer().args).toContain("--headless");
    expect(playwrightServer({ headless: false }).args).not.toContain("--headless");
  });
});

describe("discovery report", () => {
  it("lists servers, tools, classification status and schemas", () => {
    const report = buildReport(
      [{ name: "ado", command: "npx", args: ["-y", "@azure-devops/mcp@latest", "org"] }],
      [
        {
          server: "ado",
          name: "wit_get_work_item",
          description: "Get | item",
          inputSchema: { type: "object" },
          policyClass: "destructive",
        },
        { server: "ado", name: "known", description: "", inputSchema: {}, policyClass: "read" },
      ],
      { "ado.known": { policyClass: "read" } },
      new Date("2026-09-12T18:00:00Z"),
    );
    expect(report.servers[0]!.toolCount).toBe(2);
    expect(report.tools.map((t) => [t.qualified, t.classified])).toEqual([
      ["ado.known", true],
      ["ado.wit_get_work_item", false],
    ]);
    const md = renderReportMarkdown(report);
    expect(md).toContain("1 not yet in the governance manifest");
    expect(md).toContain("| `ado.wit_get_work_item` | destructive | **no** | Get \\| item |");
    expect(md).toContain("### `ado.known`");
    expect(md).toContain('"type": "object"');
    // JSON twin is what A5 reads back
    const f = join(tmp(), "r.json");
    writeFileSync(f, JSON.stringify(report));
    expect(JSON.parse(readFileSync(f, "utf8")).tools).toHaveLength(2);
  });
});

describe("playwright server options (A8)", () => {
  it("passes scope urls as origins, isolated and headless by default", () => {
    const spec = playwrightServer({
      allowedOrigins: ["http://localhost:3100", "https://staging.example.com/app"],
    });
    expect(spec.args).toContain("--headless");
    expect(spec.args).toContain("--isolated");
    const i = spec.args.indexOf("--allowed-origins");
    expect(spec.args[i + 1]).toBe("http://localhost:3100;https://staging.example.com");
  });

  it("omits the flag when the allow-list is empty or wildcarded", () => {
    expect(playwrightServer().args).not.toContain("--allowed-origins");
    expect(playwrightServer({ allowedOrigins: ["*"] }).args).not.toContain("--allowed-origins");
    expect(originsOf(["*", "https://*.example.com", "nonsense"])).toEqual([]);
  });

  it("reduces entries to bare origins and de-duplicates", () => {
    expect(originsOf(["http://localhost:3100/a", "http://localhost:3100/b"])).toEqual([
      "http://localhost:3100",
    ]);
  });
});
