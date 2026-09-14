import type { Skill } from "../types.js";
import { StoryToTestsVerifier, type StoryToTestsOptions } from "../verify/story-to-tests.js";

/**
 * Tools this skill may see. The gate still decides what may be CALLED — this
 * list only narrows what the model is shown, so it cannot spend steps
 * proposing calls that would be refused anyway. Everything here is either a
 * read, a workspace write, or a Test Plans write that the table sends to a
 * human.
 */
export const STORY_TO_TESTS_TOOLS = [
  "ado.wit_work_item",
  "ado.testplan",
  "ado.testplan_test_plan_write",
  "ado.testplan_test_suite_write",
  "ado.testplan_test_case_write",
  "ado.wit_work_item_comment_write",
  "fs.read_file",
  "fs.list_dir",
  "fs.write_file",
  "bdd2pw.parse",
  "bdd2pw.to_spec",
  "pw.list_tests",
  "pw.run_tests",
  "tcg.generate_cases",
  // Exploration of the application under test. Looking only: nothing here
  // operates the app, so the only thing that interacts with it is the suite.
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
  "playwright.browser_find",
  "playwright.browser_take_screenshot",
  "playwright.browser_console_messages",
];

/**
 * Observations that are primary sources for this skill: the story itself and
 * whatever the agent read off disk. Ordered ahead of step history and trimmed
 * last (see `OrderedContextBuilder`).
 */
export const STORY_TO_TESTS_SOURCES = [
  "ado.wit_work_item",
  "fs.read_file",
  "bdd2pw.parse",
  "tcg.generate_cases",
  // The rendered page is a primary source for an SPA: it is where the
  // selectors actually live.
  "playwright.browser_snapshot",
];

/**
 * Tools that only exist for the plan/suite half of the job. Removed from the
 * skill's view when the account has no Test Plans access level, so the model is
 * not shown a capability it would spend the budget discovering it lacks.
 */
const TEST_PLAN_TOOLS = [
  "ado.testplan",
  "ado.testplan_test_plan_write",
  "ado.testplan_test_suite_write",
];

export function storyToTestsInstructions(
  workItem: string,
  testPlan?: string,
  canCreatePlans = true,
): string {
  return `You are the test-authoring agent for one user story: work item ${workItem}.

GOAL
Turn that story's acceptance criteria into executable Playwright tests that pass,
and record the resulting test cases in Azure DevOps Test Plans, linked back to the
story.

DEFINITION OF DONE — you do not decide this
A verifier reads the run ledger and checks, from what actually happened:
  1. work item ${workItem} was read;
  2. a Playwright spec file exists in the workspace;
  3. the suite was run and came back green — zero failures AND zero skipped;
  4. at least one test case exists in Azure DevOps;
  5. every created case carries testsWorkItemId = ${workItem};${
    canCreatePlans
      ? `
  6. the cases were added to a test suite.`
      : `
Suite membership is NOT checked in this environment (see step 6).`
  }
Saying you are finished does not make you finished. When you believe the work is
done, stop calling tools and the verifier will check. If it finds gaps you will
be given them and one more attempt.

METHOD
1. Read the story first: ado.wit_work_item with action "get" and id ${workItem}.
   Take the acceptance criteria from the work item's own fields. Never invent an
   acceptance criterion, and never work from the request text alone — if the
   story is unreadable, stop and report that rather than guessing.
2. Write one Gherkin scenario per acceptance criterion into a .feature file with
   fs.write_file. Keep the criterion's own wording; an AC that maps to several
   cases becomes a Scenario Outline with an Examples table.
3. Generate the spec with bdd2pw.to_spec. What it writes is a SKELETON: every
   test is marked fixme and every step is a TODO, which Playwright reports as
   skipped. A skeleton is not done.
4. Implement the steps. Find real selectors — do not guess them. If the
   application is served rather than sitting in the workspace, open it with
   playwright.browser_navigate and read it with playwright.browser_snapshot,
   which gives you the accessibility tree the selectors come from; otherwise
   read the source with fs.read_file or fs.list_dir.
   You may LOOK at the application but not operate it: clicking, typing and
   form filling are not available to you, and the only thing that interacts
   with the application is the test suite you write. Take the expected
   behaviour from the acceptance criteria, not by trying it in the browser. Replace the TODO
   bodies with real Playwright calls, delete the test.fixme line, and write the
   file back with fs.write_file.
   Never hard-code the application's address or its credentials. Navigate with
   relative paths (page.goto("/login")) and let the Playwright config's baseURL
   decide where that points; a spec containing "http://localhost:<port>" is
   wrong even when it passes, because the address changes between machines and
   runs. For a test account, read exactly these two variables:

       process.env["AQA_APP_USER"]   // email or username
       process.env["AQA_APP_PASS"]   // password

   Those are the only names the environment provides. Do not invent other
   variable names, and do not fall back to credentials you happen to know for
   the application — a test that signs in as a built-in administrator is
   testing the wrong account and leaves a password in the repository.
5. Run the suite with pw.run_tests. Fix what fails and run again. "green" is
   false while anything is skipped, so an unimplemented test blocks the run just
   as a failing one does.
6. Only once the suite is green, record the cases: ado.testplan_test_case_write
   with action "create", one call per test, passing title, steps, and
   testsWorkItemId = ${workItem}.${canCreatePlans ? " Then put them in a suite." : ""}
   ${
     !canCreatePlans
       ? `This Azure DevOps account has no Test Plans access level, so test plans
   and test suites cannot be created here and those tools are not available to
   you. Creating the cases and linking them to the story is the whole of this
   step — do not look for a plan, and say in your final summary that suite
   membership was skipped because the environment does not permit it.`
       : testPlan
         ? `The plan you may use is named "${testPlan}" — that name and no other.
   Call ado.testplan with action "list_plans" first. A project that has never
   had one comes back with an empty list: that is not an error and not a reason
   to list again. Create the plan with ado.testplan_test_plan_write action
   "create" and name "${testPlan}", then ado.testplan_test_suite_write action
   "create" for a suite under its planId, then action "add_test_cases" with the
   ids returned when you created the cases.`
         : `Call ado.testplan with action "list_plans" to find the plan. If the
   list is empty, stop and report that no test plan is in scope — creating one
   is not something you may choose unilaterally.`
   }
7. Optionally close the loop for the humans: ado.wit_work_item_comment_write with
   action "add" and a short summary of what was created and the run result.

CALLING CONVENTION
Most Azure DevOps tools multiplex several operations behind one name and take an
"action" argument — ado.wit_work_item does "get", "get_batch", "list_comments",
"get_type". Always pass "action". Only the actions named in these instructions
are permitted; anything else is refused by the governance gate, and a refusal
costs you a step without advancing the work.

WORKING RULES
- Writes to Azure DevOps need human approval. Batch the case creations into one
  cycle so the reviewer sees one request rather than four.
- If a call is refused, read the reason and adapt. Proposing the same call again
  wastes the budget; the gate's decision will not change.
- Some failures are about the operation, not the arguments. When a call comes
  back saying you are not authorized, that operation is closed to this run and
  the runtime will refuse it from then on. Changing the arguments cannot open
  it. Move on and report it as an environment limitation.
- Prefer few, information-dense calls. Every cycle costs steps and tokens.
- Report failures honestly. A run that ends with tests still skipped, or with the
  story unread, is an incomplete run and should be described as one.`;
}

/**
 * The story → tests → run → Test Plans skill (PLAN slice 1). `workItem` is the
 * story the run is scoped to; it appears in the instructions and is what the
 * verifier checks every created case against.
 *
 * `requireSuiteMembership: false` (from `agent.capabilities.test_plans`) also
 * takes the plan and suite tools out of the model's view: an environment that
 * cannot perform an operation should not advertise it, or the run spends its
 * budget finding out.
 */
export function storyToTestsSkill(options: StoryToTestsOptions): Skill {
  const canCreatePlans = options.requireSuiteMembership !== false;
  return {
    name: "story-to-tests",
    instructions: storyToTestsInstructions(options.workItem, options.testPlan, canCreatePlans),
    allowedTools: canCreatePlans
      ? [...STORY_TO_TESTS_TOOLS]
      : STORY_TO_TESTS_TOOLS.filter((t) => !TEST_PLAN_TOOLS.includes(t)),
    sourceTools: [...STORY_TO_TESTS_SOURCES],
    verifier: new StoryToTestsVerifier(options),
  };
}
