import type { PolicyClass } from "../types.js";
import type { ActionDescriptor, ScopeArgs } from "../runtime/tools.js";

/**
 * Governance manifest: what the gate knows about each MCP tool BEFORE any run.
 * Keyed by qualified name "<server>.<tool>". A tool a server exposes that is
 * NOT in the manifest defaults to `destructive` (→ refused), so a server can
 * never smuggle in a capability the manifest has not classified.
 *
 * The `ado.*` and `playwright.*` entries below were written at step A5 from
 * `docs/tools-observed.md` — the 67 tools recorded by `aqa discover` against
 * the sandbox on 2026-09-12 (@azure-devops/mcp 2.10.0, @playwright/mcp 0.0.80).
 * No tool or action name here is from memory; each one appears in that file.
 *
 * ACTION MULTIPLEXING. Microsoft's server exposes one tool per subject area and
 * selects the operation with an `action` argument, mixing reads and writes:
 * `wit_backlog` does `list` and `reorder`; `wit_work_item_link_write` does
 * `link` and `unlink`; `pipelines_write` does `run_pipeline` and
 * `create_pipeline`. Classifying per TOOL would therefore either refuse the
 * reads we need or admit the writes we do not want, so entries classify per
 * ACTION and an unlisted action is refused like an unknown tool.
 */
export interface ManifestEntry {
  /**
   * Class for the tool as a whole. For an action-multiplexed entry this MUST
   * be the worst case over `actions` (asserted by a unit test) — it is what the
   * model and the dry-run see.
   */
  policyClass: PolicyClass;
  scopeArgs?: ScopeArgs;
  actionArg?: string;
  actions?: Record<string, ActionDescriptor>;
}

export type Manifest = Record<string, ManifestEntry>;

export const UNCLASSIFIED: ManifestEntry = { policyClass: "destructive" };

/** Azure DevOps: every entry multiplexes on `action`. */
const ACTION = "action";

export const DEFAULT_MANIFEST: Manifest = {
  // ---------------------------------------------------------------- fs (in-process)
  "fs.read_file": { policyClass: "read" },
  "fs.list_dir": { policyClass: "read" },
  "fs.write_file": { policyClass: "write_workspace" },

  // ---------------------------------------------------------------- bdd2pw (in-process)
  "bdd2pw.parse": { policyClass: "read" },
  "bdd2pw.to_spec": { policyClass: "write_workspace" },

  // ---------------------------------------------------------------- pw (in-process)
  "pw.list_tests": { policyClass: "read" },
  "pw.run_tests": { policyClass: "write_workspace" },

  // ---------------------------------------------------------------- aqa (in-process)
  // The run's own report, counted from the ledger. Reads the ledger; writes
  // nothing anywhere.
  "aqa.run_summary": { policyClass: "read" },

  // ---------------------------------------------------------------- tcg (in-process)
  "tcg.generate_cases": { policyClass: "read" },

  // ---------------------------------------------------------------- synthdata (in-process)
  "synthdata.generate": { policyClass: "write_workspace" },

  // ---------------------------------------------------------------- Azure DevOps: work items
  "ado.wit_work_item": {
    policyClass: "read",
    actionArg: ACTION,
    actions: {
      get: { policyClass: "read", scopeArgs: { workItem: "id" } },
      get_batch: { policyClass: "read", scopeArgs: { workItem: "ids" } },
      list_comments: { policyClass: "read", scopeArgs: { workItem: "workItemId" } },
      // Work item TYPE metadata (fields of "Test Case") carries no work item id.
      get_type: { policyClass: "read" },
    },
  },
  "ado.wit_query": {
    policyClass: "read",
    actionArg: ACTION,
    // WIQL is read-only and project-bounded; results are re-checked per work
    // item when the agent goes on to read or write one.
    actions: { wiql: { policyClass: "read" } },
  },
  "ado.wit_work_item_comment_write": {
    policyClass: "write_record",
    actionArg: ACTION,
    actions: {
      add: { policyClass: "write_record", scopeArgs: { workItem: "workItemId" } },
      // `update` (editing someone else's comment) stays unlisted → refused.
    },
  },

  // ---------------------------------------------------------------- Azure DevOps: test plans
  "ado.testplan": {
    policyClass: "read",
    actionArg: ACTION,
    actions: {
      list_plans: { policyClass: "read" },
      list_suites: { policyClass: "read", scopeArgs: { testPlan: "planId" } },
      list_cases: { policyClass: "read", scopeArgs: { testPlan: "planId" } },
    },
  },
  "ado.testplan_test_plan_write": {
    policyClass: "write_record",
    actionArg: ACTION,
    actions: { create: { policyClass: "write_record", scopeArgs: { testPlan: "name" } } },
  },
  "ado.testplan_test_suite_write": {
    policyClass: "write_record",
    actionArg: ACTION,
    actions: {
      create: { policyClass: "write_record", scopeArgs: { testPlan: "planId" } },
      add_test_cases: { policyClass: "write_record", scopeArgs: { testPlan: "planId" } },
    },
  },
  "ado.testplan_test_case_write": {
    policyClass: "write_record",
    actionArg: ACTION,
    actions: {
      // `testsWorkItemId` links the new case to the story it came from. It is
      // declared as the scope argument deliberately: a case the agent cannot
      // trace back to an in-scope story is refused rather than created loose.
      create: { policyClass: "write_record", scopeArgs: { workItem: "testsWorkItemId" } },
      // `update_steps` addresses a test case by its own id, which is not a
      // scope dimension we hold; it stays write_record → ask, so a human sees it.
      update_steps: { policyClass: "write_record" },
    },
  },

  // ---------------------------------------------------------------- Azure DevOps: repos
  // Not used by slice 1 (story → tests → run → Test Plans); classified now
  // because branch scoping already exists and slice 2 needs exactly this one.
  "ado.repo_create_branch": {
    policyClass: "write_branch",
    scopeArgs: { repo: "repositoryId", branch: "branchName" },
  },

  // ---------------------------------------------------------------- Playwright: exploration only
  //
  // The agent may LOOK at the application under test; it may not OPERATE it.
  // Navigation is admitted (scope-checked against agent.scope.urls) together
  // with the tools that read the rendered page, because an SPA's selectors
  // exist only in the DOM and cannot be read off disk. Everything that acts on
  // the page — click, type, fill_form, press_key, select_option, hover, drag,
  // drop, file_upload, handle_dialog — stays unclassified, so the only thing
  // that ever interacts with the application is the TEST SUITE the agent
  // writes, under `pw.run_tests`. That keeps the agent's exploration free of
  // side effects on the system under test, and it means a run cannot quietly
  // change the app's state and then assert against it.
  //
  // `browser_evaluate` and `browser_run_code_unsafe` execute arbitrary
  // JavaScript in the page and the Playwright server respectively, and are
  // never classified.
  "playwright.browser_navigate": {
    policyClass: "write_workspace",
    scopeArgs: { url: "url" },
  },
  "playwright.browser_navigate_back": { policyClass: "write_workspace" },
  "playwright.browser_snapshot": { policyClass: "read" },
  "playwright.browser_console_messages": { policyClass: "read" },
  "playwright.browser_network_requests": { policyClass: "read" },
  "playwright.browser_network_request": { policyClass: "read" },
  "playwright.browser_find": { policyClass: "read" },
  "playwright.browser_wait_for": { policyClass: "read" },
  // Writes an image file into the Playwright output directory.
  "playwright.browser_take_screenshot": { policyClass: "write_workspace" },
};

export function classify(qualified: string, manifest: Manifest = DEFAULT_MANIFEST): ManifestEntry {
  return manifest[qualified] ?? UNCLASSIFIED;
}

const RANK: Record<PolicyClass, number> = {
  read: 0,
  write_workspace: 1,
  write_branch: 2,
  write_record: 3,
  destructive: 4,
};

/**
 * Worst case over an entry's actions (or the entry's own class when it has
 * none). This is what the tool advertises to the model.
 */
export function entryClass(entry: ManifestEntry): PolicyClass {
  const actions = Object.values(entry.actions ?? {});
  if (actions.length === 0) return entry.policyClass;
  return actions.reduce<PolicyClass>(
    (worst, a) => (RANK[a.policyClass] > RANK[worst] ? a.policyClass : worst),
    "read",
  );
}
