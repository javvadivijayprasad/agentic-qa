/**
 * Core types for @vijaypjavvadi/agentic-qa.
 *
 * Everything the platform tails or the paper cites is defined here. Changing any
 * exported shape in this file is a MAJOR version bump (see PLAN §0.6).
 */

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Discriminator for every ledger line. Order here is documentation only. */
export const EVENT_KINDS = [
  "request",
  "plan",
  "context",
  "inference",
  "policy",
  "approval_requested",
  "approval_resolved",
  "call",
  "observation",
  "verify",
  "end",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** Governance classes. Each proposed tool call is assigned exactly one. */
export const POLICY_CLASSES = [
  "read",
  "write_workspace",
  "write_branch",
  "write_record",
  "destructive",
] as const;
export type PolicyClass = (typeof POLICY_CLASSES)[number];

export type PolicyDecision = "execute" | "ask" | "refuse";
export type ApprovalDecision = "approved" | "denied";
export type RunStatus = "done" | "blocked" | "refused" | "budget" | "error";

/** Exit codes per PLAN §0.1. */
export const EXIT_CODES: Record<RunStatus, number> = {
  done: 0,
  error: 1,
  blocked: 2,
  refused: 3,
  budget: 4,
};

export interface RequestPayload {
  text: string;
  skill: string;
  configHash: string;
}

export interface PlanPayload {
  steps: string[];
}

/** Hashes and counts only — never content (SECRETS-CHECKLIST). */
export interface ContextPayload {
  /** `dropped` counts history items trimmed from that section by a token cap (A6, additive). */
  sections: Array<{ name: string; sha256: string; tokens: number; dropped?: number }>;
  totalTokens: number;
  /** Total history items trimmed this cycle, when any (A6, additive). */
  droppedItems?: number;
}

export interface InferencePayload {
  model: string;
  promptVersion: string;
  /** `null` when the model declared the goal reached instead of choosing a tool. */
  toolName: string | null;
  args: Record<string, unknown> | null;
  /**
   * The model's own words when it declared the goal reached (A7, additive and
   * optional). Recorded so the ledger shows the CLAIM next to the verifier's
   * verdict — the two disagreeing is the most informative thing in a failed run.
   */
  note?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface PolicyPayload {
  toolName: string;
  class: PolicyClass;
  decision: PolicyDecision;
  reason: string;
  approvalId?: string;
}

export interface ApprovalRequestedPayload {
  approvalId: string;
  /** One human sentence, e.g. "Create 4 test cases in plan Sandbox Plan, linked to #1". */
  summary: string;
  calls: Array<{ toolName: string; args: Record<string, unknown> }>;
}

export interface ApprovalResolvedPayload {
  approvalId: string;
  decision: ApprovalDecision;
  by: string;
  at: string;
}

export interface CallPayload {
  server: string;
  toolName: string;
  args: Record<string, unknown>;
  startedAt: number;
}

export interface ObservationPayload {
  eventIdOfCall: number;
  ok: boolean;
  /** Full tool result. Compaction happens in context assembly, never here. */
  result: unknown;
  artefacts: string[];
  durationMs: number;
}

export interface Gap {
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface VerifyPayload {
  done: boolean;
  gaps: Gap[];
  /**
   * Checks the verifier did NOT make, and why (A8b, additive and optional). A
   * run can be done without being complete — an account without the Test Plans
   * access level cannot put cases in a suite — and the difference belongs in
   * the ledger rather than in a footnote, so that a reader of the evidence can
   * see what was verified and what was merely not required.
   */
  limitations?: string[];
}

export interface EndPayload {
  status: RunStatus;
  summary: string;
  exitCode: number;
}

export interface PayloadByKind {
  request: RequestPayload;
  plan: PlanPayload;
  context: ContextPayload;
  inference: InferencePayload;
  policy: PolicyPayload;
  approval_requested: ApprovalRequestedPayload;
  approval_resolved: ApprovalResolvedPayload;
  call: CallPayload;
  observation: ObservationPayload;
  verify: VerifyPayload;
  end: EndPayload;
}

/**
 * One ledger line. Mirrors the pw-extensions `RunEvent` envelope so the three
 * tool families are cross-readable (`tool` is always "agentic-qa" here).
 */
export interface RunEvent<K extends EventKind = EventKind> {
  tool: "agentic-qa";
  runId: string;
  eventId: number;
  timestamp: number;
  kind: K;
  payload: PayloadByKind[K];
}

export type AnyRunEvent = { [K in EventKind]: RunEvent<K> }[EventKind];

// ---------------------------------------------------------------------------
// Config (PLAN §0.3)
// ---------------------------------------------------------------------------

export interface ScopeConfig {
  work_items: string[];
  repos: string[];
  test_plans: string[];
  branches_writable: string[];
  /**
   * Origins (or URL prefixes/globs) the agent may point a browser at (A8).
   * Empty means the agent may not browse at all. Enforced by the gate on every
   * navigation; see `ScopedGate` for what this does and does not cover.
   */
  urls: string[];
}

export type PolicyTable = Record<PolicyClass, PolicyDecision>;

/**
 * What the ENVIRONMENT can do, as opposed to what the agent is allowed to do
 * (`policy`) or where it may act (`scope`). A capability that is off is not a
 * permission the operator withheld; it is a thing this Azure DevOps account
 * cannot do at all, and the run should neither attempt it nor be failed for
 * not having done it.
 */
export interface CapabilitiesConfig {
  /**
   * Whether test PLANS and SUITES may be created. Creating a test *case* is an
   * ordinary work-item write and needs only Basic access; creating a plan or a
   * suite goes through the Test Plans service, which needs the Test Plans
   * access level (a paid extension) and answers "You are not authorized to
   * access this API" without it. Set false on an account that does not have it:
   * the run then records cases linked to the story and reports the missing
   * suite membership as an environment limitation rather than a gap.
   */
  test_plans: boolean;
}

export const DEFAULT_CAPABILITIES: CapabilitiesConfig = { test_plans: true };

export interface AgentConfig {
  model: string;
  prompt_version: string;
  budgets: { steps: number; tokens: number };
  scope: ScopeConfig;
  policy: PolicyTable;
  /** Additive and optional (A8b); defaults to `DEFAULT_CAPABILITIES`. */
  capabilities: CapabilitiesConfig;
}

export const DEFAULT_POLICY: PolicyTable = {
  read: "execute",
  write_workspace: "execute",
  write_branch: "ask",
  write_record: "ask",
  destructive: "refuse",
};

// ---------------------------------------------------------------------------
// Skills and verifiers
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  /** System-prompt fragment appended to the runtime instructions. */
  instructions: string;
  /** Tool names (server-qualified, e.g. "ado.wit_work_item") the model may call. */
  allowedTools: string[];
  /**
   * Tools whose observations are primary sources for this skill (A6, additive
   * and optional). Context assembly orders them ahead of the step history and
   * trims them last.
   */
  sourceTools?: string[];
  verifier: Verifier;
}

export interface VerifierInput {
  events: AnyRunEvent[];
  workspaceDir: string;
}

export interface Verifier {
  name: string;
  verify(input: VerifierInput): Promise<VerifyPayload>;
}
