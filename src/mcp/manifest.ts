import type { PolicyClass } from "../types.js";
import type { ToolDescriptor } from "../runtime/tools.js";

/**
 * Governance manifest: what the gate knows about each MCP tool BEFORE any run.
 * Keyed by qualified name "<server>.<tool>". A tool a server exposes that is
 * NOT in the manifest defaults to `destructive` (→ refused), so a server can
 * never smuggle in a capability the manifest has not classified.
 *
 * The entries below for `ado` and `playwright` are FILLED IN AT STEP A5 from
 * `docs/tools-observed.md` — the real tool names recorded by `aqa discover`
 * against the sandbox. Until then they are empty on purpose (no guessing).
 */
export interface ManifestEntry {
  policyClass: PolicyClass;
  scopeArgs?: ToolDescriptor["scopeArgs"];
}

export type Manifest = Record<string, ManifestEntry>;

export const UNCLASSIFIED: ManifestEntry = { policyClass: "destructive" };

export const DEFAULT_MANIFEST: Manifest = {
  // fs adapter (in-process, workspace-bounded)
  "fs.read_file": { policyClass: "read" },
  "fs.list_dir": { policyClass: "read" },
  "fs.write_file": { policyClass: "write_workspace" },
  // ado.* and playwright.* — populated in A5 from observed tools.
};

export function classify(qualified: string, manifest: Manifest = DEFAULT_MANIFEST): ManifestEntry {
  return manifest[qualified] ?? UNCLASSIFIED;
}
