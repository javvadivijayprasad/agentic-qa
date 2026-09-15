# Usage

Install, configure, run, read the result, fix what goes wrong.

For what it does, see [FUNCTIONAL.md](FUNCTIONAL.md). For the contracts, see
[TECHNICAL.md](TECHNICAL.md).

---

## Before you start

| you need                  | why                                                     |
| ------------------------- | ------------------------------------------------------- |
| Node 18 or later          | the runtime                                             |
| An Anthropic API key      | the model                                               |
| An Azure DevOps PAT       | reading the story, creating test cases                  |
| A running application     | it explores the real UI to find selectors               |
| A disposable test account | in that application — never a real user, never an admin |

The PAT needs **Work Items (read & write)**. Add **Test Management (read & write)** only if your
organisation has the Test Plans access level; without that licence the scope makes no difference
(see Troubleshooting).

## Install

```bash
npm install -g @vijaypjavvadi/agentic-qa
aqa --version
```

Or from a clone, which is what you want if you plan to change anything:

```bash
git clone https://github.com/javvadivijayprasad/agentic-qa
cd agentic-qa && npm ci && npm run build
node dist/cli.js --help
```

Everything below writes `aqa`; from a clone it is `node dist/cli.js`.

---

## Configure

### `.env`

Beside your config. Git-ignored — `.env.example` lists the names.

```
ANTHROPIC_API_KEY=sk-ant-…
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-org
AZURE_DEVOPS_PROJECT=your-project
AZURE_DEVOPS_PAT=…

AQA_APP_URL=http://localhost:3000
AQA_APP_USER=test@example.com
AQA_APP_PASS=…
```

The last three are read by your workspace's `playwright.config.ts`, not by the runtime — they are
how a generated test signs in without a password ever reaching a spec file or a work item.

A variable already set in your shell wins over `.env`. That is standard, and it is also the single
most common way to spend an hour confused: if `.env` looks right and authentication still fails,
check for a stale `ANTHROPIC_API_KEY` in your environment. The startup line tells you which source
each key came from.

### `ai-quality.config.yaml`

This is where you say what the agent may do, and where.

```yaml
agent:
  model: claude-sonnet-4-6
  budgets:
    steps: 60
    tokens: 1500000

  scope:
    work_items: ["1"] # exact ids, or ranges: "100-199"
    repos: [] # repo names it may write to
    test_plans: [] # test plans it may write into
    branches_writable: ["agent/*"] # glob; protected branches always refused
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

Three dimensions, answering three different questions:

- **`policy`** — what is the agent _allowed_ to do. Your decision.
- **`scope`** — _where_ may it act. Your decision.
- **`capabilities`** — what _can_ this environment do at all. Not a decision; a fact about your
  Azure DevOps account.

An empty `urls` list means it may not browse at all. `scope` is required; everything else has a
default.

### The workspace

The folder the agent writes into, passed as `--workspace`. It needs a `playwright.config.ts` whose
`baseURL` comes from the environment:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  retries: 0,
  use: { baseURL: process.env.AQA_APP_URL },
});
```

Everything the agent writes lands inside this folder and nowhere else. Add `tests/`,
`test-results/`, `playwright-report/` and `.aqa-report/` to your `.gitignore` if you do not want
generated output committed.

---

## Run

### Look before you leap

```bash
aqa run "Write tests for AB#1" --config ai-quality.config.yaml --dry-run
```

Connects to the MCP servers, lists every tool it would have, and prints each one's governance class
and what the policy table would decide. No model call, no tool call, nothing spent. Worth doing once
after any config change.

### The real thing

```bash
aqa run "Write tests for AB#1" \
  --config ai-quality.config.yaml \
  --workspace ./qa
```

The work item comes from the request text (`AB#1`, `#1`, `work item 1`) unless `--work-item` says
otherwise, and it must be in `scope.work_items` — otherwise the run refuses before spending a token.

Stay at the keyboard. It will ask before it writes anything to Azure DevOps.

### All the flags

```
aqa run "<request>" --config <file>
    [--workspace .]              where the agent writes
    [--ledger .aqa]              where the run record goes
    [--env .env]                 credentials file
    [--work-item <id>]           override the id parsed from the request
    [--approval terminal|file]   who answers approvals
    [--approval-timeout <secs>]  file mode only; default 1800
    [--servers ado,playwright,fs,bdd2pw,pw]
    [--dry-run]
```

### Approvals

**Terminal mode** (default) prints the batch and waits for `y`. Anything else denies. All the calls
from one cycle appear in one prompt — that is deliberate, so you review a decision rather than click
through four.

**File mode** is for when nobody is watching. Each batch is written to
`<ledger>/runs/<runId>/approvals/<id>.json` with `decision: null`; answer it by writing the same
object back with `decision` set to `"approved"` or `"denied"`. Silence past `--approval-timeout`
denies and ends the run.

---

## Read the result

```bash
aqa replay .aqa                      # the latest run, as Markdown
aqa replay .aqa/runs/<runId>         # a specific one
aqa replay .aqa --out report.md
```

No network, no model, no tool calls — it renders from the ledger alone. Every number traces to an
event id.

Look for three things:

- **the `end` line** — the status and why
- **`Verifier gaps`** — what was not achieved, with evidence of what was seen instead
- **`Checks not made`** — what the environment prevented, which is different from a failure

### Exit codes

| code | status    | what it means                                                      |
| ---- | --------- | ------------------------------------------------------------------ |
| 0    | `done`    | the verifier found no gaps                                         |
| 1    | `error`   | the runtime itself failed                                          |
| 2    | `blocked` | gaps remain, or it stopped making progress, or approval was denied |
| 3    | `refused` | out of scope — nothing was spent                                   |
| 4    | `budget`  | steps or tokens exhausted                                          |

---

## Cost

Roughly **$0.50 per story**, ten model calls. Re-runs are cheaper. Output tokens are about 3% of the
bill — almost all of it is re-reading context each cycle.

To spend less:

- **Lower `budgets.steps`.** A run that is going wrong is a run that keeps paying.
- **Narrow `scope.work_items`.** Out-of-scope refusals happen before any token is spent.
- **Use `--dry-run`** after config changes rather than discovering the problem mid-run.

A blocked run costs roughly twice a successful one, because it keeps paying full price per cycle to
rediscover the same wall. If runs are blocking often, read the ledger — that is what it is for.

---

## Troubleshooting

Every entry here is something that actually happened during development.

**`401 authentication_error` and `.env` looks correct**
A stale `ANTHROPIC_API_KEY` in your shell is shadowing the file. The startup line names the source
each key came from; if it says "from the shell environment (NOT .env)", that is your answer.

**A browser window opens asking me to sign in to Azure DevOps**
The Azure DevOps MCP server defaults to interactive OAuth. The runtime passes `--authentication
envvar` and supplies the PAT through the child process environment, so if you see this, the PAT is
not reaching it — check `AZURE_DEVOPS_PAT` is set and non-empty.

**`Error creating test plan: You are not authorized to access this API`**
Your account has no Test Plans access level. This is a licence, not a permission — no PAT scope and
no project setting will change it, because creating a test _plan_ goes through a paid service while
creating a test _case_ is an ordinary work-item write. Set `capabilities.test_plans: false`; the run
will create and link cases and record the suite step as a limitation.

**`Client does not support form elicitation`**
The Azure DevOps server is asking for a project name it was not given. Check
`AZURE_DEVOPS_PROJECT` is set.

**`spawn EINVAL` on Windows**
Node will not spawn a `.cmd` directly. Handled by the runtime; if you see it from your own tooling,
that is the cause.

**`Playwright produced no JSON report`**
The suite did not run. Check that `@playwright/test` is installed where the workspace can see it and
that `npx playwright test` works by hand in that folder.

**The run ends `blocked: no progress`**
The agent proposed the same calls three cycles running. Usually it is stuck on something it cannot
do — read the ledger from the end backwards; the last few observations say why.

**It created duplicate test cases**
It should not — it reads what is already linked before creating. If it does, the story's existing
cases are not linked by a _Tested By_ relationship, so it cannot see them.

**Tests pass but assert nothing**
Check for `test.fixme` in the spec. A skipped test keeps `green` false, so a run should not finish
this way — but if you edited the spec by hand, that guard is only applied at run time.

---

## In CI

It works unattended, with two caveats.

```bash
aqa run "Write tests for AB#$WORK_ITEM" \
  --config ai-quality.config.yaml \
  --workspace ./qa \
  --approval file \
  --approval-timeout 300
```

**Nothing answers the approvals.** With no reviewer, every gated call denies at the timeout and the
run ends blocked. Either have your pipeline write the decision files, or set
`policy.write_record: execute` for a pipeline that is trusted to create test cases without a human —
a decision worth making deliberately rather than by default.

**Do not set `AQA_SANDBOX=1`.** It relaxes URL scope to allow `*`. It exists for local
experimentation.

Archive `<ledger>/runs/<runId>/` as a build artefact. It is the only way to understand a failed run
after the fact.

It holds no prompt text and no Azure DevOps token, but tool results are stored verbatim because they
are the evidence — so it contains whatever your systems returned during the run. Archive it
internally without hesitation; read it before publishing one outside the organisation.
