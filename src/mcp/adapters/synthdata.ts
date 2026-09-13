import { existsSync, statSync } from "node:fs";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";
import { FsTools } from "./fs.js";
import { execFileRunner, splitCommand, type CommandRunner } from "./process.js";

export interface SynthdataOptions {
  runner?: CommandRunner;
  timeoutMs?: number;
}

/**
 * In-process `synthdata` adapter: the project's synthetic test-data generator,
 * configured as `SYNTHDATA_CMD` (e.g. `python tools/synthdata.py`). Invoked as
 *
 *     <SYNTHDATA_CMD> --schema <schema> --count <n> --out <path>
 *
 * with the output path forced inside the workspace. No shell is involved, so
 * nothing in an argument can be interpreted as a command.
 */
export class SynthdataTools implements ToolClient {
  readonly server = "synthdata";
  private readonly fs: FsTools;
  private readonly runner: CommandRunner;
  private readonly timeoutMs: number;

  constructor(
    private readonly commandLine: string,
    private readonly workspace: string,
    opts: SynthdataOptions = {},
  ) {
    this.fs = new FsTools(workspace);
    this.runner = opts.runner ?? execFileRunner;
    this.timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      {
        server: this.server,
        name: "generate",
        description:
          "Generate synthetic test data for a named schema into a workspace file. Never touches real data.",
        inputSchema: {
          type: "object",
          properties: {
            schema: { type: "string", description: "Schema or entity name to generate" },
            count: { type: "integer", description: "How many records", default: 10 },
            out: { type: "string", description: "Output file, workspace-relative" },
          },
          required: ["schema", "out"],
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server || name !== "generate")
      return fail(`unknown synthdata tool: ${server}.${name}`);
    const schema = args["schema"];
    const out = args["out"];
    if (typeof schema !== "string" || !schema) return fail(`"schema" is required`);
    if (typeof out !== "string" || !out) return fail(`"out" is required`);
    const outAbs = this.fs.inside(out);
    if (!outAbs) return fail(`path escapes the workspace: ${out}`);
    const count = typeof args["count"] === "number" ? Math.trunc(args["count"]) : 10;
    if (!Number.isFinite(count) || count < 1) return fail(`"count" must be a positive integer`);

    const parts = splitCommand(this.commandLine);
    if (!parts) return fail(`SYNTHDATA_CMD is empty`);
    const r = await this.runner(
      parts.command,
      [...parts.args, "--schema", schema, "--count", String(count), "--out", out],
      { cwd: this.workspace, timeoutMs: this.timeoutMs },
    );
    if (r.code !== 0) {
      return fail(`synthdata exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-500)}`);
    }
    const wrote = existsSync(outAbs);
    return {
      ok: true,
      result: {
        path: out,
        schema,
        count,
        bytes: wrote ? statSync(outAbs).size : 0,
        stdout: r.stdout.trim().slice(-2000),
      },
      artefacts: wrote ? [out] : [],
    };
  }
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
