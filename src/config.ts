import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { AgentConfig, PolicyDecision, PolicyTable, ScopeConfig } from "./types.js";
import { DEFAULT_POLICY, POLICY_CLASSES } from "./types.js";

/**
 * Loads the `agent:` section of `ai-quality.config.yaml` (PLAN §0.3). JSON is
 * accepted too (same shape) so tests and the platform can hand over a generated
 * file without a YAML dependency on their side.
 */
export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_BUDGETS = { steps: 40, tokens: 400_000 };

export async function loadAgentConfig(file: string): Promise<AgentConfig> {
  const path = resolve(file);
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
  const text = readFileSync(path, "utf8");
  const raw = await parseConfigText(text, extname(path));
  return agentConfigFromObject(raw, path);
}

export async function parseConfigText(text: string, ext: string): Promise<unknown> {
  if (ext === ".json") return JSON.parse(text);
  // YAML — `yaml` is a runtime dependency; imported lazily so JSON users never load it.
  const { parse } = await import("yaml");
  return parse(text);
}

export function agentConfigFromObject(raw: unknown, source = "<config>"): AgentConfig {
  if (!isObject(raw)) throw new ConfigError(`${source}: top level must be a mapping`);
  const agent = raw["agent"];
  if (!isObject(agent)) throw new ConfigError(`${source}: missing "agent:" section`);

  const model = str(agent["model"]) ?? "claude-sonnet-4-6";
  const prompt_version = str(agent["prompt_version"]) ?? "aqa-prompt-v0.1.0";

  const b = isObject(agent["budgets"]) ? agent["budgets"] : {};
  const budgets = {
    steps: posInt(b["steps"], DEFAULT_BUDGETS.steps, `${source}: agent.budgets.steps`),
    tokens: posInt(b["tokens"], DEFAULT_BUDGETS.tokens, `${source}: agent.budgets.tokens`),
  };

  const s = agent["scope"];
  if (!isObject(s)) throw new ConfigError(`${source}: agent.scope is required`);
  const scope: ScopeConfig = {
    work_items: strList(s["work_items"], `${source}: agent.scope.work_items`),
    repos: strList(s["repos"], `${source}: agent.scope.repos`),
    test_plans: strList(s["test_plans"], `${source}: agent.scope.test_plans`),
    branches_writable: strList(s["branches_writable"], `${source}: agent.scope.branches_writable`),
  };

  const p = isObject(agent["policy"]) ? agent["policy"] : {};
  const policy = { ...DEFAULT_POLICY } as PolicyTable;
  for (const cls of POLICY_CLASSES) {
    const v = p[cls];
    if (v === undefined) continue;
    if (v !== "execute" && v !== "ask" && v !== "refuse")
      throw new ConfigError(`${source}: agent.policy.${cls} must be execute | ask | refuse`);
    policy[cls] = v as PolicyDecision;
  }
  for (const key of Object.keys(p)) {
    if (!(POLICY_CLASSES as readonly string[]).includes(key))
      throw new ConfigError(`${source}: agent.policy has unknown class "${key}"`);
  }

  return { model, prompt_version, budgets, scope, policy };
}

// ---------------------------------------------------------------------------
// .env loader (tiny, dependency-free). Never logs values.
// ---------------------------------------------------------------------------

export function loadDotEnv(file = ".env", env: NodeJS.ProcessEnv = process.env): string[] {
  const path = resolve(file);
  if (!existsSync(path)) return [];
  const loaded: string[] = [];
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

/** The environment the runtime needs (PLAN §0.2). Values are never printed. */
export interface RuntimeEnv {
  anthropicApiKey: string;
  model?: string;
  azureDevOps?: { orgUrl: string; org: string; pat: string; project: string };
  tcgUrl?: string;
  governanceUrl?: string;
  synthdataCmd?: string;
  sandbox: boolean;
}

export function readRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { requireAnthropic?: boolean } = {},
): RuntimeEnv {
  const key = env["ANTHROPIC_API_KEY"];
  if (opts.requireAnthropic !== false && !key)
    throw new ConfigError("ANTHROPIC_API_KEY is not set");
  const orgUrl = env["AZURE_DEVOPS_ORG_URL"];
  let azureDevOps: RuntimeEnv["azureDevOps"];
  if (orgUrl) {
    const pat = env["AZURE_DEVOPS_PAT"];
    const project = env["AZURE_DEVOPS_PROJECT"];
    if (!pat) throw new ConfigError("AZURE_DEVOPS_PAT is not set (AZURE_DEVOPS_ORG_URL is)");
    if (!project)
      throw new ConfigError("AZURE_DEVOPS_PROJECT is not set (AZURE_DEVOPS_ORG_URL is)");
    azureDevOps = { orgUrl, org: orgNameFromUrl(orgUrl), pat, project };
  }
  const out: RuntimeEnv = { anthropicApiKey: key ?? "", sandbox: env["AQA_SANDBOX"] === "1" };
  if (env["AQA_MODEL"]) out.model = env["AQA_MODEL"];
  if (azureDevOps) out.azureDevOps = azureDevOps;
  if (env["TCG_URL"]) out.tcgUrl = env["TCG_URL"];
  if (env["AI_GOVERNANCE_URL"]) out.governanceUrl = env["AI_GOVERNANCE_URL"];
  if (env["SYNTHDATA_CMD"]) out.synthdataCmd = env["SYNTHDATA_CMD"];
  return out;
}

/** `https://dev.azure.com/jvijayprasad` → `jvijayprasad`; `https://org.visualstudio.com` → `org`. */
export function orgNameFromUrl(orgUrl: string): string {
  const u = new URL(orgUrl);
  if (u.hostname === "dev.azure.com") {
    const seg = u.pathname.split("/").filter(Boolean)[0];
    if (!seg) throw new ConfigError(`AZURE_DEVOPS_ORG_URL has no organisation segment: ${orgUrl}`);
    return seg;
  }
  const m = /^([^.]+)\.visualstudio\.com$/.exec(u.hostname);
  if (m?.[1]) return m[1];
  throw new ConfigError(`AZURE_DEVOPS_ORG_URL is not a recognised Azure DevOps URL: ${orgUrl}`);
}

// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function posInt(v: unknown, dflt: number, where: string): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    throw new ConfigError(`${where} must be a positive integer`);
  return v;
}
function strList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" || typeof x === "number"))
    throw new ConfigError(`${where} must be a list of strings`);
  return v.map(String);
}
