import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import type { ToolClient, ToolDescriptor, ToolResult } from "../../runtime/tools.js";

/**
 * In-process `fs` adapter: read / list / write strictly inside the job
 * workspace. Any path that resolves outside the workspace is refused here,
 * before the gate even sees it — defence in depth (design §5).
 */
export class FsTools implements ToolClient {
  readonly server = "fs";
  private readonly root: string;

  constructor(workspaceDir: string) {
    this.root = resolve(workspaceDir);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    const path = { type: "string", description: "Path relative to the workspace root" };
    return [
      {
        server: this.server,
        name: "read_file",
        description: "Read a UTF-8 text file inside the workspace (max 200 KB).",
        inputSchema: { type: "object", properties: { path }, required: ["path"] },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "list_dir",
        description: "List files and directories inside the workspace.",
        inputSchema: { type: "object", properties: { path: { ...path, default: "." } } },
        policyClass: "read",
      },
      {
        server: this.server,
        name: "write_file",
        description:
          "Write a UTF-8 text file inside the workspace, creating directories as needed.",
        inputSchema: {
          type: "object",
          properties: { path, content: { type: "string" } },
          required: ["path", "content"],
        },
        policyClass: "write_workspace",
      },
    ];
  }

  async call(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (server !== this.server) return fail(`not an fs tool: ${server}.${name}`);
    const rel =
      typeof args["path"] === "string" ? args["path"] : name === "list_dir" ? "." : undefined;
    if (rel === undefined) return fail(`"path" is required`);
    const abs = this.inside(rel);
    if (!abs) return fail(`path escapes the workspace: ${rel}`);

    switch (name) {
      case "read_file": {
        if (!existsSync(abs) || !statSync(abs).isFile()) return fail(`no such file: ${rel}`);
        if (statSync(abs).size > 200 * 1024) return fail(`file too large (>200 KB): ${rel}`);
        return {
          ok: true,
          result: { path: rel, content: readFileSync(abs, "utf8") },
          artefacts: [],
        };
      }
      case "list_dir": {
        if (!existsSync(abs) || !statSync(abs).isDirectory())
          return fail(`no such directory: ${rel}`);
        const entries = readdirSync(abs, { withFileTypes: true })
          .map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, result: { path: rel, entries }, artefacts: [] };
      }
      case "write_file": {
        const content = args["content"];
        if (typeof content !== "string") return fail(`"content" must be a string`);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
        return {
          ok: true,
          result: { path: rel, bytes: Buffer.byteLength(content, "utf8") },
          artefacts: [rel],
        };
      }
      default:
        return fail(`unknown fs tool: ${name}`);
    }
  }

  /** Resolve `rel` under the root; return undefined if it escapes. */
  inside(rel: string): string | undefined {
    const abs = resolve(this.root, rel);
    const r = relative(this.root, abs);
    if (r === "") return abs;
    if (r.startsWith("..") || r.split(sep)[0] === ".." || resolve(abs) !== abs) return undefined;
    return abs;
  }
}

function fail(message: string): ToolResult {
  return { ok: false, result: { message }, artefacts: [] };
}
