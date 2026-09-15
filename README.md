# agentic-qa

[![CI](https://github.com/javvadivijayprasad/agentic-qa/actions/workflows/ci.yml/badge.svg)](https://github.com/javvadivijayprasad/agentic-qa/actions/workflows/ci.yml)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22758876.svg)](https://doi.org/10.5281/zenodo.22758876)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

**A QA agent that has to show its work.**

A language model chooses the next action. Code decides whether that action is allowed. Code decides
whether the job is finished. Every step — what was proposed, what was permitted, what happened — is
appended to a ledger you can replay offline.

Point it at a user story in Azure DevOps and it reads the acceptance criteria, writes Playwright
tests, runs them against your application, and records the resulting test cases back against the
story. It asks before it writes anything you would have to undo.

```
aqa run "Write tests for AB#1" --config ai-quality.config.yaml --workspace ./qa
```

```
aqa: skill story-to-tests, work item 1, model claude-sonnet-4-6, approval terminal

[aqa] approval apr-0001 requested
  Approve 4 calls: ado.testplan_test_case_write(action=create, title=AC-1: A registered user…)
  approve? [y/N] y

done: 5 passed, 0 failed, 0 skipped — 4 test cases linked to AB#1
```

---

## Why this exists

Most teams write acceptance criteria and then, weeks later, someone turns them into automated tests
from memory. The mapping between requirement and test is maintained by hand, rots quietly, and
nobody can answer "is this story actually tested?" without opening things one at a time.

Handing that job to an AI agent creates a different problem. An agent that can write tests can also
delete a branch, rewrite a requirement, or report success it did not achieve. The interesting
question is not whether a model can write a Playwright test — it can — but whether you can let one
near your issue tracker and still be able to prove, afterwards, exactly what it did and why.

This runtime is an answer to that second question.

## Three ideas

**The model proposes; code disposes.** Every tool call is classified — read, workspace write,
branch write, record write, destructive — and a policy table you own decides: execute, ask a human,
or refuse. A tool nobody classified is refused. The safe default is no.

**The model does not grade itself.** When it believes the work is done it stops and says so. That
claim is written to the ledger and then ignored. Separate code goes back through the record and
checks that specific things were observed to happen: the story was read, a spec exists, the suite
ran green, the cases are linked to the story. Disagreement between the claim and the verdict is the
most informative thing in a failed run.

**The ledger is both the memory and the evidence.** Each cycle is rebuilt from the ledger rather
than from an open conversation with the model, which is what makes a run replayable: `aqa replay`
renders any run with no network and no tool calls, and every number in the report traces to an
event id.

## What it is built on

Tools reach the agent over the **Model Context Protocol**, from three places that are trusted
differently:

- **`@azure-devops/mcp`** (pinned 2.10.0) — work items, test cases, comments. It multiplexes many
  operations behind one tool name and an `action` argument, so it is classified _per action_: an
  action nobody classified is refused like an unknown tool.
- **`@playwright/mcp`** (pinned 0.0.80) — a live browser, for finding real selectors. It also exposes
  click, type, fill and press; those are never classified, which is how the exploration-only rule is
  enforced rather than merely stated.
- **Six in-process adapters** written for this runtime — `fs` (workspace-confined), `bdd2pw` (Gherkin
  → spec), `pw` (runs your suite, keeps the report), `summary` (renders the run report from the
  ledger), and `tcg` / `synthdata` (site-specific, opt-in). Three carry the names of the author's
  separate projects but are not dependencies on them: `bdd2pw` is reimplemented here, `synthdata`
  runs as a subprocess, `tcg` is a remote service — and enabling `tcg` sends story text to it.

Running your Playwright suite is **not** an MCP call — the Playwright server drives a browser, the
`pw` adapter runs your `playwright.config.ts`. The agent explores with the first and tests with the
second.

Three runtime dependencies: the Anthropic SDK, the MCP SDK, a YAML parser. Everything else is Node's
standard library — a runtime whose job is auditability should not itself be a supply chain.

Full inventory in [FUNCTIONAL.md](docs/FUNCTIONAL.md#what-provides-each-capability); wire formats and
event shapes in [TECHNICAL.md](docs/TECHNICAL.md).

## Install

Requires Node 18+.

```bash
npm install -g @vijaypjavvadi/agentic-qa
aqa --version
```

Or run it from a clone:

```bash
git clone https://github.com/javvadivijayprasad/agentic-qa
cd agentic-qa && npm ci && npm run build
node dist/cli.js --help
```

## Five-minute start

**1. Credentials** in a `.env` beside your config (never committed — see `.env.example`):

```
ANTHROPIC_API_KEY=sk-ant-…
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PROJECT=your-project
AZURE_DEVOPS_PAT=…            # Work Items (read & write)
AQA_APP_URL=http://localhost:3000
AQA_APP_USER=test@example.com  # a disposable account in your test environment
AQA_APP_PASS=…
```

**2. A config**, `ai-quality.config.yaml` — this is where you say what the agent may do and where:

```yaml
agent:
  model: claude-sonnet-4-6
  budgets: { steps: 60, tokens: 1500000 }
  scope:
    work_items: ["1"] # exact ids, or ranges like "100-199"
    repos: []
    test_plans: []
    branches_writable: ["agent/*"]
    urls: ["http://localhost:3000"] # where it may point a browser
  capabilities:
    test_plans: true # false if your account has no Test Plans access level
  policy:
    read: execute
    write_workspace: execute
    write_branch: ask
    write_record: ask
    destructive: refuse
```

**3. See what it would be allowed to do**, before spending anything:

```bash
aqa run "Write tests for AB#1" --config ai-quality.config.yaml --dry-run
```

**4. Run it**, with you at the keyboard:

```bash
aqa run "Write tests for AB#1" --config ai-quality.config.yaml --workspace ./qa
```

**5. Read what happened:**

```bash
aqa replay .aqa            # renders the latest run as Markdown
```

A typical story costs roughly $0.50 and ten model calls.

## What it does today

Story → tests → run → test cases. Specifically: reads a work item's acceptance criteria; writes one
Gherkin scenario per behaviour; generates and implements Playwright specs, exploring the running
application to find real selectors; runs the suite; and records one test case per acceptance
criterion in Azure DevOps, linked to the story. A re-run over an unchanged story creates nothing and
still reports.

It then posts a summary back to the work item — counted from the ledger, not written by the model:

```
## agentic-qa run `20260914T142818Z-23dd15d7`

**Suite: green** — 5 passed, 0 failed, 0 skipped.
**Test cases linked to work item 1: 4** (already present: 25, 26, 27, 28).

**Checks not made in this environment:**
- test suite membership — this account has no Test Plans access level, so the cases are
  linked to the story but no suite contains them

_Counted from the run ledger, not from the agent's account of its own work._
```

## What it will not do

Deliberate limits, not missing features:

- **It cannot operate your application.** It may navigate, snapshot, search and screenshot, to find
  real selectors. Click, type, fill and press are never classified, so they cannot be called. The
  only thing that interacts with your app is the test suite it writes.
- **It cannot edit a work item's fields.** It can create test cases and add comments. It cannot
  rewrite the acceptance criteria it is being verified against — an agent that can edit its own
  requirements is not auditable.
- **It cannot delete anything.** `destructive` refuses by default and destructive-looking tool names
  are raised to that class regardless of how they are declared.
- **It cannot write outside its workspace.** Every filesystem path resolves under the folder you
  point it at.
- **It does not publish test results to Azure Test Plans.** Creating a test _case_ works on a Basic
  licence; a test _plan_ or _suite_ needs the paid Test Plans access level. Set
  `capabilities.test_plans: false` and the run records what it could not check rather than failing.

## Documentation

| doc                                        | for                                                      |
| ------------------------------------------ | -------------------------------------------------------- |
| [Adoption](docs/ADOPTION.md)               | what a team has to change, who does it, in what order    |
| [Usage](docs/USAGE.md)                     | installing, configuring, running, reading a ledger       |
| [How a run works](docs/HOW-A-RUN-WORKS.md) | every stage of one real run, in order                    |
| [Functional](docs/FUNCTIONAL.md)           | what it does, capability by capability                   |
| [Architecture](docs/ARCHITECTURE.md)       | the design decisions, and the trade-offs behind them     |
| [Technical](docs/TECHNICAL.md)             | components, contracts, event shapes, extension points    |
| [Releasing](docs/RELEASING.md)             | cutting a version and publishing it                      |
| [CHANGELOG](CHANGELOG.md)                  | every change, with the observed failure that prompted it |

## Status

**v0.1 — one skill, working end to end, against a live Azure DevOps project and a real application.**

The `story-to-tests` skill is complete: the runs above are real, not illustrative. The runtime,
governance gate, ledger, replay and verifier are covered by 270+ tests, including a golden fixture
that fails CI on any drift in the event shapes.

Being worked on next: a daily regression pipeline, failure triage that classifies a red run before a
human looks at it, and prompt caching to cut the per-run cost.

The event shapes, CLI flags, exit codes and config schema are a contract — changing any of them is a
MAJOR version bump. Everything else is fair game.

## Contributing

Issues and pull requests are welcome, particularly: another issue tracker behind the same skill
interface, another test framework behind the `pw` adapter, and reports of what the governance
defaults get wrong in a real team.

```bash
npm ci
npm run typecheck && npm test && npm run lint && npm run build
npm run fixture:make && git diff --exit-code   # the golden ledger must not drift
```

## Citation

If you use this in published work, cite it with the metadata in
[`CITATION.cff`](CITATION.cff) — GitHub renders a "Cite this repository" button from it, and most
reference managers import it directly.

Vijay Prasad Javvadi, Independent Researcher, Plainsboro, NJ, USA · ORCID
[0009-0004-1192-6906](https://orcid.org/0009-0004-1192-6906).

Archived on Zenodo: [10.5281/zenodo.22758876](https://doi.org/10.5281/zenodo.22758876).

## License

MIT.
