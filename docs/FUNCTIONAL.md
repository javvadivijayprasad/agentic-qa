# What it does

Written for a QA engineer or test lead deciding whether this is worth their time. No code.

For the commands, see [USAGE.md](USAGE.md). For why it works this way, see
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## The job it takes on

You have a story in Azure DevOps with acceptance criteria. You want automated tests that cover
those criteria, and you want to be able to answer "is this story tested?" without opening things one
at a time.

Today that means a person reads the criteria, writes the tests, and maintains the mapping between
the two in their head or a spreadsheet. The tests get written weeks after the criteria, if at all,
and the mapping decays from the first rename onward.

This runs that job in about ten minutes and leaves the mapping as data rather than as a habit.

---

## What a run does, step by step

### 1. Reads the story

It fetches the work item and takes the acceptance criteria **from the work item's own fields**. Not
from your request text, not from the story title, not from what it assumes a login story usually
means. If the work item is unreadable it stops and says so rather than guessing.

It also reads which test cases are already linked to the story, so it knows what exists before it
writes anything.

### 2. Writes scenarios

One Gherkin scenario per behaviour, keeping the criterion's own wording. A criterion that covers
several conditions becomes several scenarios — "empty fields show validation messages" is two
behaviours, the empty email and the empty password, and it writes both.

Scenarios are named for the criterion they come from: `AC-3` when a criterion needs one test,
`AC-3a` and `AC-3b` when it needs two. Strip the letter and you have the criterion. That naming is
what makes a failing test traceable back to a requirement later.

### 3. Implements them against your real application

The generated spec is a skeleton — every test marked `fixme`, every step a TODO. Filling it in needs
real selectors, and an SPA's selectors exist only in the rendered page, so it opens your application
and reads the accessibility tree.

It can look. It cannot click, type, fill a form, or press a key. The only thing that ever interacts
with your application is the suite it writes.

It never hard-codes your application's address or credentials. Tests navigate relatively
(`page.goto("/login")`) and read the test account from environment variables, so the same suite runs
against local, CI and staging without edits.

### 4. Runs the suite

Playwright, in your workspace, headless. It fixes what fails and runs again, up to its budget.

**A skipped test counts as a failure.** A generated skeleton compiles, runs, and reports every test
as skipped — Playwright would call that a successful run. Treating it as a pass would mean shipping
a green suite that verifies nothing, so "green" here means zero failures **and** zero skipped.

### 5. Records test cases in Azure DevOps

One test case per acceptance criterion — four criteria, four cases, on every run — each linked to
the story by a _Tested By_ relationship. That link is the traceability, and it is queryable.

Note the grain: _tests_ are per behaviour, _test cases_ are per criterion. Five tests can roll up to
four cases, and that is intended.

**This is where it asks you.** Creating records in Azure DevOps needs approval, batched into one
prompt for the whole cycle — you approve "create four test cases", not four separate prompts.

### 6. Reports back

A comment on the story with the suite result, which cases were created, which already existed, and
anything the environment prevented it from checking:

```
## agentic-qa run `20260914T142818Z-23dd15d7`

**Suite: green** — 5 passed, 0 failed, 0 skipped.
**Test cases linked to work item 1: 4** (already present: 25, 26, 27, 28).

**Checks not made in this environment:**
- test suite membership — this account has no Test Plans access level, so the cases are
  linked to the story but no suite contains them

_Counted from the run ledger, not from the agent's account of its own work._
```

Every figure in that comment is counted from what was observed to happen. The agent does not write
the numbers; it posts a block that was computed for it.

---

## Running it again

The second run over an unchanged story **creates nothing**. It reads the story, sees the four cases
already linked, runs the suite, and posts a summary. One approval, no duplicates, still finishes
cleanly.

This matters more than it sounds. Most runs are second runs. A tool that files a fresh set of test
cases every time it is pointed at a story is worse than no tool, because now someone has to work out
which of the duplicates is current.

When the story _changes_, it creates cases for the criteria that are newly uncovered and updates
the steps on cases whose criterion has moved on.

---

## What it asks, and what it refuses

Every action it proposes is classified, and a table you control decides what happens.

| it does without asking                     | it asks first       | it refuses, always                   |
| ------------------------------------------ | ------------------- | ------------------------------------ |
| reading a work item                        | creating test cases | deleting anything                    |
| reading and writing files in its workspace | posting a comment   | writing to `main` or `release`       |
| running the test suite                     | pushing a branch    | editing a work item's fields         |
| looking at your application                |                     | anything nobody explicitly permitted |

Two of those are worth expanding.

**It cannot edit acceptance criteria.** It creates test cases and posts comments; it cannot change
the fields of a work item. An agent that can rewrite the requirement it is judged against cannot be
audited, so this one is enforced by the tool table rather than by instructions.

**Unknown means no.** A tool nobody has classified is treated as destructive, and destructive
refuses. New capability is invisible until someone writes it down deliberately.

Approvals default to No. An empty answer, a closed terminal, a piped run — all deny. In unattended
mode, silence past a timeout denies too.

---

## The evidence it leaves

Every run writes an append-only ledger: what the model proposed, what the gate decided and why, what
was actually called, what came back, what the verifier concluded.

```bash
aqa replay .aqa
```

renders any run as a readable report with no network calls and no model calls. Every number traces
to a specific event.

Two properties make this more than a log file:

**It is safe to archive.** Prompt text is never stored — only section hashes and token counts — and
the Azure DevOps token never enters it. Tool results, though, are kept _verbatim_, because they are
the evidence: a redacted result would no longer show what the tool returned. So a ledger holds
whatever your systems returned that day — work items, page snapshots, test output. Attach it to a
ticket freely; read it before publishing one outside the organisation.

**It records what was _not_ checked.** If the environment prevented a check — no Test Plans licence,
say — that is recorded as a limitation rather than quietly dropped. A green run with a limitation is
not the same object as a green run without one, and you can see which you have.

---

## Who decides the work is finished

Not the model. When it believes it is done it stops and says so, and that claim is written down and
then ignored.

Separate code then goes back through the record and checks six things actually happened:

1. the story was read — not guessed at
2. a spec file exists in the workspace
3. the suite ran and came back green, nothing skipped
4. test cases are linked to the story
5. if it created any, it read the existing ones first
6. every created case points back at the story

If something is missing it gets one more attempt with the specific gap. If the gap remains, the run
ends **blocked** and tells you exactly what was not achieved. A run that cannot finish says so
rather than declaring victory.

---

## What it will not do

Stated as scope, not as a roadmap:

- **It does not operate your application.** Only the tests it writes do that.
- **It does not publish test _runs_ to Azure Test Plans.** Creating a test _case_ works on a Basic
  licence; a test _plan_ or _suite_ needs the paid Test Plans access level. Where that licence is
  absent the run records what it could not do instead of failing.
- **It does not file bugs.** Not yet.
- **It does not run on a schedule.** Not yet — today it is something you invoke.
- **It does not maintain tests as your app changes.** A failing test is reported, not repaired.

---

## What it needs from you to work well

Three preconditions, in order of how much they matter:

**Acceptance criteria that say something.** "User can log in" produces a useless test. It reads your
criteria literally, which is uncomfortable at first and then useful — most teams find their first
month with this is mostly about writing better criteria.

**Stable selectors.** It finds real selectors by reading the rendered page, but if your UI is
generated class names with no `data-testid`, the tests will pass today and break on the next build.
A week of adding test ids to your key flows is a prerequisite, not a nice-to-have.

**A test environment with a known account.** A disposable user in a database you control. This is
where most test automation efforts die, with or without an agent.

---

## What it costs

About **$0.50 per story** and ten model calls, at current Sonnet pricing. A sprint of fifteen
stories is under $8.

Re-runs cost less — roughly half — because there is less to do.

Set against the two-to-three hours a person spends turning one story's criteria into working tests,
the cost is not the deciding factor in either direction. The deciding factor is whether you trust
the output, which is what the ledger and the verifier exist to answer.

---

## What provides each capability

The runtime itself does no work. It decides. Every capability above arrives through a tool, and every
tool comes from one of three places — which matters to you because the three fail differently and
are trusted differently.

**Two external MCP servers**, spawned as child processes and pinned to an exact version:

| server                     | version | supplies                                                         |
| -------------------------- | ------- | ---------------------------------------------------------------- |
| `@azure-devops/mcp`        | 2.10.0  | reading work items and their relations; creating test cases; comments |
| `@playwright/mcp`          | 0.0.80  | a live browser for exploration — navigate, snapshot, find, screenshot, console |

These are other people's code, run against your real systems, so they are the ones under the tightest
constraint. The Azure DevOps server multiplexes many operations behind a single tool name and an
`action` argument, so it is classified **per action**: `wit_get_work_item#get` is a read,
`testplan_test_case_write#create` is a record write, and an action nobody classified is refused like
an unknown tool. The Playwright server exposes click, type, fill and press — and those are simply
never classified, which is how "look, don't touch" is enforced rather than merely intended.

Both are pinned. An MCP server that changes its tool surface underneath you silently changes what
your policy table means, so `AQA_ADO_MCP_VERSION` and `AQA_PLAYWRIGHT_MCP_VERSION` override the pins
deliberately rather than by drift.

**Six in-process adapters**, which are this project's own code presenting a tool interface:

| adapter     | tools                              | does                                                             |
| ----------- | ---------------------------------- | ----------------------------------------------------------------- |
| `fs`        | `read_file`, `write_file`, `list_dir` | workspace file access; a path resolving outside the workspace is refused here, before the gate sees it |
| `bdd2pw`    | `parse`, `to_spec`                 | Gherkin feature → Playwright spec scaffold                        |
| `pw`        | `run_tests`, `list_tests`          | runs the suite and keeps the JSON report as an artefact           |
| `tcg`       | `generate_cases`                   | test-case generation service (opt-in; needs `TCG_URL`)            |
| `synthdata` | `generate`                         | synthetic test data (opt-in; needs `SYNTHDATA_CMD`)               |
| `summary`   | `run_summary`                      | renders the run report **from the ledger**, so the figures the agent posts are counted rather than recalled |

Running a Playwright *test suite* is not an MCP operation — the Playwright MCP server drives a
browser, it does not run your suite. That is the `pw` adapter, shelling out to your own
`playwright.config.ts`. The distinction matters: the agent explores with the server and tests with
the adapter, and only the second one touches your application in anger.

`tcg` and `synthdata` are site-specific and off by default. `--servers` selects what loads.

**A note on three of those names.** `bdd2pw`, `synthdata` and `tcg` are named after separate projects
of the author's, and none of them is a dependency: `bdd2pw` is reimplemented here in 240 lines,
`synthdata` is invoked as a subprocess through `SYNTHDATA_CMD`, and `tcg` is a remote service called
at `TCG_URL`. Enabling `tcg` sends the story text and its acceptance criteria to that service — it is
classed `read` because it changes nothing, which is not the same as sending nothing.

**The model**, reached through `@anthropic-ai/sdk`. It proposes; it executes nothing.

The dependency list is deliberately short — the SDK, the MCP SDK, and a YAML parser. Everything else
is Node's standard library. A runtime whose job is to be auditable should not itself be a supply
chain.

## Where it fits

Not a replacement for a QA engineer. A fast junior who never gets bored of the fourth validation
case, hands you a draft, and shows you exactly what it did.

The realistic workflow: a story is accepted, you point this at it, and twenty minutes later you
review a suite that already runs green instead of starting from an empty file. The thing being saved
is not typing — it is the activation energy of starting, which is what actually stops tests from
being written.
