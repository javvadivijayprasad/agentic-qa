import type { ToolDescriptor } from "../runtime/tools.js";
import { qualify } from "../runtime/tools.js";
import type { Manifest } from "./manifest.js";
import { UNCLASSIFIED, classify } from "./manifest.js";

export interface DiscoveryReport {
  generatedAt: string;
  servers: Array<{ name: string; command: string; args: string[]; toolCount: number }>;
  tools: Array<{
    qualified: string;
    server: string;
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    policyClass: string;
    classified: boolean;
  }>;
}

export function buildReport(
  specs: Array<{ name: string; command: string; args: string[] }>,
  tools: ToolDescriptor[],
  manifest: Manifest,
  now: Date = new Date(),
): DiscoveryReport {
  return {
    generatedAt: now.toISOString(),
    servers: specs.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      toolCount: tools.filter((t) => t.server === s.name).length,
    })),
    tools: tools
      .map((t) => {
        const q = qualify(t.server, t.name);
        const inManifest = manifest[q] !== undefined;
        // A tool counts as classified when the manifest names it, or when an
        // in-process adapter (trusted code, e.g. fs.*) declared a non-default
        // class itself. Anything else still carries the UNCLASSIFIED default.
        const policyClass = inManifest ? classify(q, manifest).policyClass : t.policyClass;
        const classified = inManifest || t.policyClass !== UNCLASSIFIED.policyClass;
        return {
          qualified: q,
          server: t.server,
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          policyClass,
          classified,
        };
      })
      .sort((a, b) => a.qualified.localeCompare(b.qualified)),
  };
}

/** `docs/tools-observed.md` — the record A5 builds the manifest from. */
export function renderReportMarkdown(r: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push("# Tools observed by `aqa discover`");
  lines.push("");
  lines.push(
    `Generated ${r.generatedAt}. Recorded from live \`listTools()\` calls — not from memory.`,
  );
  lines.push("");
  lines.push("## Servers");
  lines.push("");
  lines.push("| server | command | tools |");
  lines.push("|---|---|---|");
  for (const s of r.servers)
    lines.push(`| ${s.name} | \`${s.command} ${s.args.join(" ")}\` | ${s.toolCount} |`);
  lines.push("");
  const unclassified = r.tools.filter((t) => !t.classified).length;
  lines.push("## Tools");
  lines.push("");
  lines.push(
    `${r.tools.length} tools; ${unclassified} not yet in the governance manifest (treated as destructive → refused until classified in A5).`,
  );
  lines.push("");
  lines.push("| tool | class | in manifest | description |");
  lines.push("|---|---|---|---|");
  for (const t of r.tools)
    lines.push(
      `| \`${t.qualified}\` | ${t.policyClass} | ${t.classified ? "yes" : "**no**"} | ${cell(t.description)} |`,
    );
  lines.push("");
  lines.push("## Schemas");
  lines.push("");
  for (const t of r.tools) {
    lines.push(`### \`${t.qualified}\``);
    lines.push("");
    if (t.description) lines.push(t.description, "");
    lines.push("```json");
    lines.push(JSON.stringify(t.inputSchema, null, 2));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 160);
}
