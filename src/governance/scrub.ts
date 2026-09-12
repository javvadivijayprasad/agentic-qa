/**
 * Local scrub rules — the same families the ai-governance sidecar applies
 * (PII, API keys, tokens, IPs). Used when `AI_GOVERNANCE_URL` is unset, and
 * always applied to anything the package logs to stderr. Never used on ledger
 * observations (those are evidence and are kept verbatim).
 */

export interface ScrubRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string) => string);
}

const keep4 = (label: string) => (m: string) => `[${label}:${m.slice(0, 4)}…]`;

export const SCRUB_RULES: ScrubRule[] = [
  {
    name: "anthropic_key",
    pattern: /sk-ant-[A-Za-z0-9_-]{10,}/g,
    replacement: keep4("ANTHROPIC_KEY"),
  },
  {
    name: "openai_key",
    pattern: /sk-(?!ant-)[A-Za-z0-9_-]{20,}/g,
    replacement: keep4("OPENAI_KEY"),
  },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: keep4("AWS_KEY") },
  {
    name: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: keep4("GITHUB_TOKEN"),
  },
  {
    name: "bearer",
    pattern: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replacement: "Bearer [TOKEN]",
  },
  {
    name: "basic_auth_url",
    pattern: /(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/g,
    replacement: (m) => m.replace(/:\/\/([^:@]+):([^@]+)@/, "://$1:[PASSWORD]@"),
  },
  {
    name: "pat_assignment",
    pattern:
      /\b(AZURE_DEVOPS_PAT|PAT|pat|token|api[_-]?key|password|secret)\s*[=:]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi,
    replacement: (m) => m.replace(/([=:]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/, "$1[REDACTED]"),
  },
  {
    name: "ado_pat",
    // Azure DevOps PATs are 52-char base32-ish lowercase/digits (legacy) or 84-char (new format).
    pattern: /\b[a-z0-9]{52}\b|\b[A-Za-z0-9]{84}\b/g,
    replacement: keep4("PAT"),
  },
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[EMAIL]",
  },
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replacement: "[IP]" },
  { name: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: "[SSN]" },
  { name: "card", pattern: /\b(?:\d[ -]?){13,16}\b/g, replacement: "[CARD]" },
];

export interface ScrubResult {
  text: string;
  redactions: Array<{ rule: string; count: number }>;
}

export function scrub(text: string, rules: ScrubRule[] = SCRUB_RULES): ScrubResult {
  let out = text;
  const redactions: Array<{ rule: string; count: number }> = [];
  for (const rule of rules) {
    let count = 0;
    out = out.replace(rule.pattern, (m: string) => {
      count++;
      return typeof rule.replacement === "string" ? rule.replacement : rule.replacement(m);
    });
    if (count > 0) redactions.push({ rule: rule.name, count });
  }
  return { text: out, redactions };
}

/** Mask a secret for log output: first 4 chars + ellipsis. Never returns the full value. */
export function mask(secret: string | undefined): string {
  if (!secret) return "(unset)";
  return secret.length <= 4 ? "…" : `${secret.slice(0, 4)}…`;
}
