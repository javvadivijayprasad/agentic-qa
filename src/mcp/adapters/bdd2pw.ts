import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";

export interface GherkinStep {
  keyword: string;
  text: string;
}

export interface GherkinScenario {
  name: string;
  tags: string[];
  steps: GherkinStep[];
}

export interface GherkinFeature {
  feature: string;
  background: GherkinStep[];
  scenarios: GherkinScenario[];
}

/**
 * In-process `bdd2pw` adapter: Gherkin feature file → Playwright spec skeleton.
 *
 * Supported subset: `Feature`, `Background`, `Scenario`, `Scenario Outline`
 * with an `Examples` table (one test per row, `<param>` substituted), tags,
 * `#` comments and the Given/When/Then/And/But keywords. Anything else is
 * carried through as a step line rather than silently dropped.
 */
export class Bdd2PwTools implements ToolClient {
  readonly server = "bdd2pw";
  private readonly fs: FsTools;

  constructor(workspaceDir: string) {
    this.fs = new FsTools(workspaceDir);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "parse",
        description:
          "Parse a Gherkin .feature file in the workspace into { feature, background, scenarios[] }.",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string", description: "Feature file, workspace-relative" } },
          required: ["path"],
        },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "to_spec",
        description:
          "Generate a Playwright spec skeleton from a Gherkin feature file. Each scenario becomes a test whose steps are test.step() calls marked TODO; the test is marked fixme so an unimplemented skeleton can never report a pass.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Feature file, workspace-relative" },
            out: {
              type: "string",
              description: "Spec file to write; defaults to tests/<feature>.spec.ts",
            },
          },
          required: ["path"],
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not a bdd2pw tool: ${server}.${name}`);
    const rel = args["path"];
    if (typeof rel !== "string") return fail(`"path" is required`);
    const abs = this.fs.inside(rel);
    if (!abs) return fail(`path escapes the workspace: ${rel}`);
    if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`no such file: ${rel}`);
    const parsed = parseFeature(readFileSync(abs, "utf8"));

    if (name === "parse") return { ok: true, result: { path: rel, ...parsed }, artefacts: [] };
    if (name !== "to_spec") return fail(`unknown bdd2pw tool: ${name}`);

    const outRel =
      typeof args["out"] === "string" && args["out"] ? args["out"] : defaultSpecPath(rel);
    const outAbs = this.fs.inside(outRel);
    if (!outAbs) return fail(`path escapes the workspace: ${outRel}`);
    const source = renderSpec(parsed, rel);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, source, "utf8");
    return {
      ok: true,
      result: {
        path: outRel,
        from: rel,
        tests: parsed.scenarios.length,
        steps: parsed.scenarios.reduce((n, s) => n + s.steps.length, 0),
        unimplemented: parsed.scenarios.length,
      },
      artefacts: [outRel],
    };
  }
}

const STEP_KEYWORDS = ["Given", "When", "Then", "And", "But", "*"];

export function parseFeature(text: string): GherkinFeature {
  const out: GherkinFeature = { feature: "", background: [], scenarios: [] };
  let target: GherkinStep[] | undefined;
  let current: GherkinScenario | undefined;
  let outline: GherkinScenario | undefined;
  let examples: string[][] | undefined;
  let tags: string[] = [];

  const flushOutline = (): void => {
    if (!outline || !examples || examples.length < 2) return;
    const header = examples[0] as string[];
    for (const row of examples.slice(1)) {
      const subs = (s: string): string =>
        header.reduce((acc, h, i) => acc.split(`<${h}>`).join(row[i] ?? ""), s);
      out.scenarios.push({
        name:
          subs(outline.name) === outline.name
            ? `${outline.name} [${row.join(", ")}]`
            : subs(outline.name),
        tags: outline.tags,
        steps: outline.steps.map((st) => ({ keyword: st.keyword, text: subs(st.text) })),
      });
    }
    outline = undefined;
    examples = undefined;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("@")) {
      tags = line.split(/\s+/).filter((t) => t.startsWith("@"));
      continue;
    }
    const feature = /^Feature:\s*(.*)$/.exec(line);
    if (feature) {
      flushOutline();
      out.feature = feature[1]?.trim() ?? "";
      target = undefined;
      continue;
    }
    if (/^Background:/.test(line)) {
      flushOutline();
      target = out.background;
      continue;
    }
    const outlineHeader = /^Scenario(?: Outline| Template):\s*(.*)$/.exec(line);
    const scenarioHeader = /^(?:Scenario|Example):\s*(.*)$/.exec(line);
    if (outlineHeader || scenarioHeader) {
      flushOutline();
      current = {
        name: (outlineHeader ?? scenarioHeader)?.[1]?.trim() ?? "",
        tags,
        steps: [],
      };
      tags = [];
      target = current.steps;
      if (outlineHeader) outline = current;
      else out.scenarios.push(current);
      continue;
    }
    if (/^Examples:/.test(line)) {
      examples = [];
      target = undefined;
      continue;
    }
    if (line.startsWith("|")) {
      if (examples)
        examples.push(
          line
            .slice(1, line.endsWith("|") ? -1 : undefined)
            .split("|")
            .map((c) => c.trim()),
        );
      continue;
    }
    const step = new RegExp(`^(${STEP_KEYWORDS.map(escapeRe).join("|")})\\s+(.*)$`).exec(line);
    if (step && target) {
      target.push({ keyword: step[1] as string, text: (step[2] ?? "").trim() });
      continue;
    }
    // Unrecognised non-empty line inside a scenario: keep it as a step so
    // nothing is lost between the story and the generated spec.
    if (target) target.push({ keyword: "*", text: line });
  }
  flushOutline();
  return out;
}

/** Playwright spec skeleton. Steps are TODOs and every test is `fixme`. */
export function renderSpec(f: GherkinFeature, from: string): string {
  const L: string[] = [];
  L.push(`// Generated by agentic-qa (bdd2pw) from ${from}.`);
  L.push("// Steps are placeholders: each test is marked fixme so a skeleton can never");
  L.push("// report a pass. Implement the steps, then remove the fixme line.");
  L.push('import { test } from "@playwright/test";');
  L.push("");
  L.push(`test.describe(${q(f.feature || "Feature")}, () => {`);
  for (const s of f.scenarios) {
    L.push(`  test(${q(s.name)}, async ({ page }) => {`);
    L.push(`    test.fixme(true, "generated skeleton: steps are not implemented");`);
    for (const st of [...f.background, ...s.steps]) {
      L.push(`    await test.step(${q(`${st.keyword} ${st.text}`.trim())}, async () => {`);
      L.push("      // TODO: implement");
      L.push("    });");
    }
    L.push("  });");
    L.push("");
  }
  if (f.scenarios.length === 0) L.push("  // no scenarios found in the feature file");
  L.push("});");
  L.push("");
  return L.join("\n");
}

function defaultSpecPath(featurePath: string): string {
  const base = (featurePath.split(/[\\/]/).pop() ?? "feature").replace(/\.feature$/i, "");
  return `tests/${base}.spec.ts`;
}

function q(s: string): string {
  return JSON.stringify(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
