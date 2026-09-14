import type { RuntimeEnv } from "../config.js";
import type { ServerSpec } from "./client.js";

/**
 * Default server specs (PLAN §1 A4/A5). Versions are PINNED to the exact
 * releases whose tool surface `docs/tools-observed.md` records (67 tools
 * enumerated 2026-09-12 against the sandbox). The governance manifest is
 * written against those names, so an unpinned upgrade could silently add or
 * rename tools; anything not in the manifest is refused, but pinning keeps the
 * reproducibility bundle honest. Override per run with the env vars below.
 *
 * Azure DevOps MCP server: Microsoft's `@azure-devops/mcp`. It authenticates via
 * Azure identity by default; PAT support is passed through the environment.
 * Playwright MCP: Microsoft's `@playwright/mcp` — browser automation (navigate,
 * snapshot, click…). Running a Playwright TEST SUITE is not an MCP tool; that is
 * our own adapter (A5).
 */
export const PINNED_VERSIONS = {
  ado: process.env["AQA_ADO_MCP_VERSION"] ?? "2.10.0",
  playwright: process.env["AQA_PLAYWRIGHT_MCP_VERSION"] ?? "0.0.80",
};

/**
 * Azure DevOps MCP server.
 *
 * AUTHENTICATION. The server's default is `--authentication interactive`, which
 * opens a browser for an OAuth redirect — fine at a desk, useless in CI, and
 * not reproducible for a paper. `--authentication envvar` takes a PAT from
 * `ADO_MCP_AUTH_TOKEN` instead, which is what this passes. The token goes in
 * the child's environment and never into argv, where a process listing or the
 * ledger's own `call` events would expose it.
 *
 * (A4 guessed at three other variable names and none of them was honoured; the
 * server silently fell back to the browser. Fixed in A8 against Microsoft's
 * documented flag.)
 */
export function azureDevOpsServer(env: RuntimeEnv): ServerSpec {
  if (!env.azureDevOps)
    throw new Error("Azure DevOps env is not configured (AZURE_DEVOPS_ORG_URL)");
  const { org, pat, project, orgUrl } = env.azureDevOps;
  return {
    name: "ado",
    command: npxCommand(),
    args: ["-y", `@azure-devops/mcp@${PINNED_VERSIONS.ado}`, org, "--authentication", "envvar"],
    env: {
      ADO_MCP_AUTH_TOKEN: pat,
      // Not used for auth; kept so the server and any child tooling agree on
      // which organisation and project a bare call refers to.
      AZURE_DEVOPS_ORG_URL: orgUrl,
      AZURE_DEVOPS_PROJECT: project,
    },
    // Without this the server elicits ("which project?") and the call fails
    // outright, because elicitation needs a client that can ask a human.
    defaultArgs: { project },
  };
}

export interface PlaywrightServerOptions {
  headless?: boolean;
  /**
   * Origins from `agent.scope.urls`, passed to the server as a second layer
   * under the gate's own check. Microsoft is explicit that `--allowed-origins`
   * "does not serve as a security boundary and does not affect redirects", so
   * this narrows mistakes; it does not contain a hostile page. The gate is what
   * is auditable, because its decision is in the ledger.
   */
  allowedOrigins?: string[];
  /** Fresh profile per session (default). Keeps runs reproducible. */
  isolated?: boolean;
}

export function playwrightServer(opts: PlaywrightServerOptions = {}): ServerSpec {
  const args = ["-y", `@playwright/mcp@${PINNED_VERSIONS.playwright}`];
  if (opts.headless !== false) args.push("--headless");
  if (opts.isolated !== false) args.push("--isolated");
  const origins = originsOf(opts.allowedOrigins ?? []);
  if (origins.length > 0) args.push("--allowed-origins", origins.join(";"));
  return { name: "playwright", command: npxCommand(), args };
}

/** Allow-list entries reduced to bare origins, which is what the flag expects. */
export function originsOf(entries: string[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    if (e === "*" || e.includes("*")) continue; // a wildcard would defeat the flag
    try {
      out.add(new URL(e).origin);
    } catch {
      /* not a URL; the gate will refuse it anyway */
    }
  }
  return [...out];
}

/** Windows needs `npx.cmd` when spawned without a shell. */
export function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
