import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Gap, Verifier, VerifierInput, VerifyPayload } from "../types.js";
import {
  artefacts,
  asRecord,
  completedCalls,
  numberField,
  refusals,
  successful,
  type CallRecord,
} from "./evidence.js";

export interface StoryToTestsOptions {
  /** The work item the tests are for, e.g. "1". */
  workItem: string;
  /**
   * The test plan the run may use, from `agent.scope.test_plans`. The agent is
   * told to create it when the project has none — a fresh project has no plan,
   * and without this the run stalls listing an empty list (observed).
   */
  testPlan?: string;
  /** Minimum number of test cases that must exist in Azure DevOps. Default 1. */
  minCases?: number;
  /** Require a green Playwright run. Default true. */
  requireGreenSuite?: boolean;
  /**
   * Require the new cases to be added to a suite. Default true. Set false from
   * `agent.capabilities.test_plans` when the Azure DevOps account has no Test
   * Plans access level: the plan/suite API answers "You are not authorized to
   * access this API" there, so requiring it fails every run for a reason the
   * agent cannot act on. The check then becomes a recorded limitation.
   */
  requireSuiteMembership?: boolean;
}

/**
 * Decides "done" for the story → tests → run → Test Plans slice, from the
 * LEDGER rather than from the model's account of itself. Every check below is
 * a question about something that was observed to happen:
 *
 *   1. the story was actually read          (a successful wit_work_item get)
 *   2. a spec file exists on disk           (artefact recorded AND present)
 *   3. the suite ran, and came back green   (pw.run_tests, green === true)
 *   4. test cases exist in Azure DevOps     (successful testplan_test_case_write create)
 *   5. each case is traceable to the story  (testsWorkItemId === the work item)
 *   6. the cases are in a suite             (successful testplan_test_suite_write)
 *
 * A missing check produces a `Gap` whose `evidence` records what the verifier
 * did see, so the next cycle — and the ledger reader afterwards — can tell the
 * difference between "not attempted", "attempted and refused" and "attempted
 * and failed".
 */
export class StoryToTestsVerifier implements Verifier {
  readonly name = "story-to-tests";
  private readonly opts: Omit<Required<StoryToTestsOptions>, "testPlan"> &
    Pick<StoryToTestsOptions, "testPlan">;

  constructor(options: StoryToTestsOptions) {
    this.opts = {
      minCases: 1,
      requireGreenSuite: true,
      requireSuiteMembership: true,
      ...options,
    };
  }

  async verify(input: VerifierInput): Promise<VerifyPayload> {
    const calls = completedCalls(input.events);
    const gaps: Gap[] = [];
    const refused = refusals(input.events);

    // 1. the story was read -------------------------------------------------
    const reads = successful(calls, "ado.wit_work_item", "get").filter((c) =>
      sameId(c.args["id"], this.opts.workItem),
    );
    if (reads.length === 0) {
      gaps.push(
        gap(
          "story-not-read",
          `work item ${this.opts.workItem} was never read, so the acceptance criteria are unknown`,
          { attempted: attempts(calls, "ado.wit_work_item"), refused: refusedNames(refused) },
        ),
      );
    }

    // 2. a spec file exists -------------------------------------------------
    const specs = artefacts(calls).filter(isSpecPath);
    const present = specs.filter((p) => fileExists(input.workspaceDir, p));
    if (present.length === 0) {
      gaps.push(
        gap("no-spec-written", "no Playwright spec file was written into the workspace", {
          artefactsRecorded: artefacts(calls),
          specArtefacts: specs,
        }),
      );
    }

    // 3. the suite ran and is green ----------------------------------------
    const runs = successful(calls, "pw.run_tests");
    const last = runs[runs.length - 1];
    if (!last) {
      gaps.push(
        gap("suite-not-run", "the generated tests were never executed", {
          attempted: attempts(calls, "pw.run_tests"),
        }),
      );
    } else if (this.opts.requireGreenSuite) {
      const r = asRecord(last.result) ?? {};
      if (r["green"] !== true) {
        gaps.push(
          gap(
            "suite-not-green",
            skippedOnly(r)
              ? `the suite ran but ${String(r["skipped"])} test(s) are still unimplemented (fixme), so nothing was actually verified`
              : `the suite ran but is not green: ${String(r["passed"] ?? 0)} passed, ${String(r["failed"] ?? 0)} failed, ${String(r["skipped"] ?? 0)} skipped`,
            {
              passed: r["passed"],
              failed: r["failed"],
              skipped: r["skipped"],
              failures: r["failures"],
            },
          ),
        );
      }
    }

    // 4 + 5. test cases exist, and trace back to the story -------------------
    const created = successful(calls, "ado.testplan_test_case_write", "create");
    if (created.length < this.opts.minCases) {
      gaps.push(
        gap(
          "no-test-cases",
          `${created.length} test case(s) were created in Azure DevOps; at least ${this.opts.minCases} is required`,
          { created: created.length, attempted: attempts(calls, "ado.testplan_test_case_write") },
        ),
      );
    }
    const untraceable = created.filter(
      (c) => !sameId(c.args["testsWorkItemId"], this.opts.workItem),
    );
    if (untraceable.length > 0) {
      gaps.push(
        gap(
          "cases-not-linked",
          `${untraceable.length} test case(s) are not linked to work item ${this.opts.workItem}`,
          { titles: untraceable.map((c) => String(c.args["title"] ?? "(untitled)")) },
        ),
      );
    }

    // 6. the cases are in a suite -------------------------------------------
    const limitations: string[] = [];
    if (this.opts.requireSuiteMembership && created.length > 0) {
      const suiteWrites = successful(calls, "ado.testplan_test_suite_write");
      if (suiteWrites.length === 0) {
        gaps.push(
          gap("cases-not-in-suite", "the new test cases were not added to a test suite", {
            created: created.length,
            attempted: attempts(calls, "ado.testplan_test_suite_write"),
          }),
        );
      }
    } else if (!this.opts.requireSuiteMembership) {
      limitations.push(
        "suite membership was not checked: agent.capabilities.test_plans is false, so this " +
          "Azure DevOps account cannot create test plans or suites. The cases exist and are " +
          "linked to the story, but no suite contains them.",
      );
    }

    return {
      done: gaps.length === 0,
      gaps,
      ...(limitations.length > 0 ? { limitations } : {}),
    };
  }
}

/** Case ids as reported by Azure DevOps, for the run summary. Best effort. */
export function createdCaseIds(events: VerifierInput["events"]): number[] {
  return successful(completedCalls(events), "ado.testplan_test_case_write", "create")
    .map((c) => numberField(c.result, "id", "workItemId", "testCaseId"))
    .filter((n): n is number => n !== undefined);
}

/**
 * Pull a work item reference out of a request: "AB#1", "#1", "work item 1",
 * "story 1". Returns the first match — the runtime scopes a run to one story.
 */
export function parseWorkItemRef(text: string): string | undefined {
  const m =
    /\bAB#(\d+)\b/i.exec(text) ??
    /#(\d+)\b/.exec(text) ??
    /\b(?:work item|story|user story|item)\s+(\d+)\b/i.exec(text);
  return m?.[1];
}

// ---------------------------------------------------------------------------

function gap(code: string, message: string, evidence: Record<string, unknown>): Gap {
  return { code, message, evidence };
}

/** Ids arrive as numbers or strings depending on the caller; compare as text. */
function sameId(value: unknown, want: string): boolean {
  if (typeof value === "number") return String(value) === want;
  if (typeof value === "string") return value.trim() === want;
  return false;
}

function isSpecPath(p: string): boolean {
  return /\.(spec|test)\.(ts|js|mts|cts|tsx)$/i.test(p);
}

function fileExists(workspaceDir: string, rel: string): boolean {
  const abs = resolve(workspaceDir, rel);
  return existsSync(abs) && statSync(abs).isFile();
}

/** What was tried for a tool, successful or not — the "not attempted" signal. */
function attempts(calls: CallRecord[], toolName: string): Array<{ action?: string; ok: boolean }> {
  return calls
    .filter((c) => c.toolName === toolName)
    .map((c) => (c.action !== undefined ? { action: c.action, ok: c.ok } : { ok: c.ok }));
}

function refusedNames(refused: Array<{ toolName: string; reason: string }>): string[] {
  return [...new Set(refused.map((r) => r.toolName))];
}

function skippedOnly(r: Record<string, unknown>): boolean {
  return Number(r["failed"] ?? 0) === 0 && Number(r["skipped"] ?? 0) > 0;
}
