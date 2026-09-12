import type { RuntimeEnv } from "../config.js";
import type { ServerSpec } from "./client.js";

/**
 * Default server specs (PLAN §1 A4). Versions are pinned AFTER `aqa discover`
 * has run against the sandbox and `docs/tools-observed.md` records what each
 * version exposes — until then we deliberately spawn "latest" and print the
 * resolved version in the discovery report.
 *
 * Azure DevOps MCP server: Microsoft's `@azure-devops/mcp`. It authenticates via
 * Azure identity by default; PAT support is passed through the environment and
 * confirmed by the discovery run (see handoff). Playwright MCP: Microsoft's
 * `@playwright/mcp` — browser automation (navigate, snapshot, click…). Running a
 * Playwright TEST SUITE is not an MCP tool; that is our own adapter (A5).
 */
export const PINNED_VERSIONS = {
  ado: process.env["AQA_ADO_MCP_VERSION"] ?? "latest",
  playwright: process.env["AQA_PLAYWRIGHT_MCP_VERSION"] ?? "latest",
};

export function azureDevOpsServer(env: RuntimeEnv): ServerSpec {
  if (!env.azureDevOps)
    throw new Error("Azure DevOps env is not configured (AZURE_DEVOPS_ORG_URL)");
  const { org, pat, project, orgUrl } = env.azureDevOps;
  return {
    name: "ado",
    command: npxCommand(),
    args: ["-y", `@azure-devops/mcp@${PINNED_VERSIONS.ado}`, org],
    env: {
      // Both spellings are provided; discovery confirms which the server honours.
      AZURE_DEVOPS_EXT_PAT: pat,
      ADO_MCP_AUTH_TYPE: "pat",
      AZURE_DEVOPS_PAT: pat,
      AZURE_DEVOPS_ORG_URL: orgUrl,
      AZURE_DEVOPS_PROJECT: project,
    },
  };
}

export function playwrightServer(opts: { headless?: boolean } = {}): ServerSpec {
  const args = ["-y", `@playwright/mcp@${PINNED_VERSIONS.playwright}`];
  if (opts.headless !== false) args.push("--headless");
  return { name: "playwright", command: npxCommand(), args };
}

/** Windows needs `npx.cmd` when spawned without a shell. */
export function npxCommand(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}
