# How a run works

Every stage of one run, in order: what it does, what goes in, what comes out, which component owns
it.

This follows a real run — `20260914T034436Z-a69f71a5`, 83 events, against work item AB#1 and a live
application. It happens to contain everything worth seeing: a refusal, two approvals, a failed
verification, a retry, and a clean finish. Event numbers throughout refer to that ledger.

For the contracts each stage uses, see [TECHNICAL.md](TECHNICAL.md). For why the stages are divided
this way, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Stage 0 — Startup, before anything is spent

**Owner:** `src/cli.ts` · **In:** command line, `.env`, config file · **Out:** a wired runtime, or an
early exit

```
aqa run "Write tests for AB#1" --config ai-quality.config.yaml --workspace examples/sandbox
```

In order:

1. **Flags parsed.** `--approval` must be `terminal` or `file`; `--approval-timeout` must be a
   positive number of seconds. A bad flag exits 1 before anything connects.
2. **`.env` loaded**, then the runtime environment read. A variable already set in the shell wins —
   except an empty one, which does not. The startup line names the source of each key, which is the
   only reason a shadowed API key is a five-second diagnosis rather than an hour's.
3. **Config loaded and validated.** Unknown keys under `policy` or `capabilities` are errors, not
   silent no-ops. `agent.scope` is required.
4. **Work item resolved** from the request text — `AB#1`, `#1`, `work item 1` — unless `--work-item`
   overrides it.
5. **Scope checked.** If that work item is not in `agent.scope.work_items`, the run exits **3
   (refused)** here. Nothing has been spent: no model call, no server spawned.
6. **Ledger created** at `<ledger>/runs/<runId>/`, where `runId` is `YYYYMMDDTHHMMSSZ-<8 hex>`.
7. **Servers spawned and adapters constructed.** The Azure DevOps and Playwright MCP servers as
   child processes over stdio; `fs`, `bdd2pw`, `pw` in-process. Then `aqa.run_summary` is composed
   on top, because it needs the ledger — which `buildTooling` deliberately knows nothing about.
8. **Skill, gate, approver, model** built. The skill's shape depends on `capabilities`: with
   `test_plans: false`, the plan and suite tools are removed from its `allowedTools` entirely.

`--dry-run` stops here, after printing every visible tool with its class and what the policy table
would decide. It is the cheapest way to check a config change.

---

## Stage 1 — The request event

**Owner:** `runtime/loop.ts` · **Out:** event 1

```json
{ "text": "Write tests for AB#1", "skill": "story-to-tests", "configHash": "sha256:e3259388…" }
```

The hash is of the whole resolved config. Two runs with the same hash were governed by identical
rules; two that differ were not, and the ledger says so without anyone having to remember.

---

## Stage 2 — Tools, narrowed

**Owner:** `runtime/loop.ts` · **In:** every tool every server offers · **Out:** the subset the model
will see

`listTools()` across all clients returns everything available. The skill's `allowedTools` then
filters it down — in this run, from 71 tools to 19.

This is **not** a security boundary. The gate is. Narrowing exists so the model does not spend
cycles proposing calls that would be refused anyway. A tool removed here is still refused if
something else reaches for it.

The skill's `sourceTools` are also collected now. They decide how much room an observation gets in
later context: **16,000 characters** for a primary source, **2,000** for an ordinary step result.

---

## Stage 3 — The plan

**Owner:** `runtime/anthropic.ts` · **In:** instructions + request + tool schemas · **Out:** event 2

One model call, producing a list of intended steps. In this run:

> **Read the story** – Call `ado.wit_work_item` with `action "get"` and `id 1` … No guessing or
> inventing criteria.
> **Write a feature file** – Translate each acceptance criterion into a Gherkin scenario …

The plan is recorded and **never consulted again**. It is not a program the loop executes — each
cycle decides afresh. It exists so a reader can compare what the agent said it would do with what it
then did, which is occasionally the most interesting comparison in the file.

---

## Stage 4 — The cycle

Everything from here repeats until the model stops, a budget runs out, or a stop rule fires. Seven
steps each time.

### 4a. Context assembly

**Owner:** `runtime/context.ts` (`OrderedContextBuilder`) · **Out:** a `context` event

The cycle's input is built fresh from the ledger. Five sections, in this order:

| section        | what it is                           | trimmed? |
| -------------- | ------------------------------------ | -------- |
| `instructions` | the skill's prompt fragment          | never    |
| `request`      | what was asked                       | never    |
| `tool_schemas` | the 19 tools, verbatim from MCP      | never    |
| `sources`      | observations from `sourceTools`      | last     |
| `history`      | ordinary step results, gate feedback | first    |

Event 3 shows the first cycle: instructions 1,314 tokens, tool schemas 3,284, sources and history
empty — 4,605 total. By event 72 it had grown to 13,279.

Note what the event contains: section **names, SHA-256 hashes and token counts**. Never the text. A
ledger can be attached to a ticket without review.

The model's own notes from the last four cycles are appended here too. Without them the input would
be identical cycle to cycle and the model would make the identical decision — which is exactly what
early runs did.

### 4b. Inference

**Owner:** `runtime/anthropic.ts` · **Out:** one `inference` event per proposed call

The model returns either a set of tool calls or nothing. Nothing means "I believe this is finished"
— jump to Stage 5.

Tools are wired into the request with their governance class stated in the description, so the model
knows before proposing that a call will need approval. `defaultArgs` — currently the Azure DevOps
project — are merged **before** the gate sees the call, so the ledger and the policy decision both
describe what was actually sent.

Several calls in one cycle is normal. Events 16–18 are three proposed in one go.

### 4c. The gate

**Owner:** `governance/policy.ts` · **Out:** one `policy` event per call

Seven stages, each able to raise the class or refuse, none able to lower it: resolve the operation
from its `action` argument → class from the manifest → destructive-name raise → protected-branch
raise → URL scope → scope allow-lists → policy table.

Event 12, from this run:

```json
{
  "toolName": "playwright.browser_navigate",
  "class": "write_workspace",
  "decision": "refuse",
  "reason": "url \"/\" is not in the allowed urls"
}
```

The model had proposed `url: "/"` — a relative path, sensible-looking, and not an allowed origin.
The gate refused it, the reason went back as history, and the agent read the workspace instead. One
step lost; nothing else.

A refusal is fed to the model as a history item, not as an error. The run continues.

### 4d. Progress checks

**Owner:** `runtime/loop.ts`

Two filters before anything executes:

- **The repeat memo.** A cycle whose calls were _all_ made before has advanced nothing. It gets one
  piece of feedback, then a third consecutive repeat ends the run as `blocked`. A successful call
  that produced artefacts, or that is not a read, clears the memo — otherwise re-running a suite
  after fixing it would look like repetition.
- **Closed operations.** An operation the environment already refused on authorization grounds is
  forced to `refuse`, **before** the approval batch is assembled, so no human is asked to approve a
  call already known to be dead.

### 4e. Approval

**Owner:** `runtime/approvers.ts` · **Out:** `approval_requested`, `approval_resolved`

Every `ask` in the cycle goes into **one** request. Event 55 carries all four test case creations:

```
Approve 4 calls: ado.testplan_test_case_write(action=create, title=AC-1: A registered user…);
  …(title=AC-2: Submitting a valid email…); …(AC-3…); …(AC-4…)
```

Terminal mode prints it and waits for `y`; anything else denies. File mode writes
`approvals/apr-0001.json` with `decision: null` and polls until someone answers or the timeout
denies for them.

If every call in a cycle was denied, the run ends `blocked`.

### 4f. Execution

**Owner:** the `ToolClient` for that server · **Out:** a `call` event, then an `observation`

The `call` event is written _before_ the tool runs, so a crashed run still shows what it was
attempting. The `observation` carries the full result — compaction happens later, in context
assembly, never here.

Refused and denied calls never reach this step. They appear in the ledger as `policy` events with no
`call` following, which is how a reader tells "refused" from "attempted and failed".

### 4g. History

**Owner:** `runtime/loop.ts`

The result is compacted for the model's next context — by role, using the `sourceTools` split — and
pushed onto history. Then the cycle begins again.

---

## Stage 5 — Stopping

**Owner:** the model, then `runtime/loop.ts` · **Out:** an `inference` event with `toolName: null`

At event 73 the model proposed nothing and said why. That claim is recorded — and then ignored. It
sits in the ledger as the model's account of itself, next to the verifier's verdict.

---

## Stage 6 — Verification, and the one retry

**Owner:** `verify/story-to-tests.ts` · **In:** the whole ledger + the workspace · **Out:** a
`verify` event

The verifier reads the ledger, not the model's claims. Six checks: the story was read; a spec exists
on disk; the suite ran green with nothing skipped; cases are linked to the story; if any were
created, the existing ones were read first; every created case points back at the story.

Event 74 — the first verdict in this run — said **not done**:

```json
{
  "done": false,
  "gaps": [
    {
      "code": "no-spec-written",
      "message": "no Playwright spec file was written into the workspace",
      "evidence": { "artefactsRecorded": [], "specArtefacts": [] }
    }
  ],
  "limitations": ["suite membership was not checked: agent.capabilities.test_plans is false …"]
}
```

The agent had reused a spec already in the workspace from an earlier run, so nothing in _this_ run
had recorded it. The gap went back as feedback, the agent wrote the file (events 76–79), and event
82 came back `done`.

**One retry, not unlimited.** If gaps remain after it, the run ends `blocked` and names them. A run
that cannot finish says so rather than declaring victory.

Note `limitations` in both verdicts: a check the environment prevented, recorded rather than
dropped. It appears in a `done` verdict too — because a green run with a limitation is not the same
object as a green run without one.

---

## Stage 7 — The end

**Owner:** `runtime/loop.ts`, then `cli.ts` · **Out:** the `end` event, `summary.md`, an exit code

```json
{ "status": "done", "summary": "…", "exitCode": 0 }
```

`summary.md` is rendered beside the ledger — the same output `aqa replay` produces. Then the MCP
child processes are closed and the process exits with the status code.

| status    | exit | reached when                                            |
| --------- | ---- | ------------------------------------------------------- |
| `done`    | 0    | the verifier found no gaps                              |
| `error`   | 1    | the runtime threw                                       |
| `blocked` | 2    | gaps after the retry, no progress, or every call denied |
| `refused` | 3    | scope check failed at Stage 0                           |
| `budget`  | 4    | steps or tokens exhausted                               |

---

## Who owns what

| stage            | component                         | decides                                 |
| ---------------- | --------------------------------- | --------------------------------------- |
| startup, wiring  | `cli.ts`                          | whether the run may start at all        |
| the cycle        | `runtime/loop.ts`                 | when to stop                            |
| context          | `runtime/context.ts`              | what the model sees, and how much of it |
| inference        | `runtime/anthropic.ts`            | _proposes_ — decides nothing            |
| permission       | `governance/policy.ts`            | execute, ask, or refuse                 |
| terminal failure | `runtime/denials.ts`              | whether an operation is closed for good |
| approval         | `runtime/approvers.ts`            | relays a human's answer; defaults to no |
| execution        | `mcp/client.ts`, `mcp/adapters/*` | nothing — it performs                   |
| evidence         | `ledger/ledger.ts`                | nothing — it records                    |
| completion       | `verify/*`                        | whether the work is done                |

The model appears once in that table, and the word next to it is _proposes_.

---

## The whole run, mapped

| events | stage                                                        |
| ------ | ------------------------------------------------------------ |
| 1      | request                                                      |
| 2      | plan                                                         |
| 3–7    | cycle 1 — read the story (`wit_work_item get`)               |
| 8–14   | cycle 2 — list the workspace; **`browser_navigate` refused** |
| 15–27  | cycle 3 — read three files                                   |
| 28–40  | cycle 4 — read three more                                    |
| 41–45  | cycle 5 — run the suite: 5 passed, 0 failed, 0 skipped       |
| 46–64  | cycle 6 — **approval apr-0001**, four test cases created     |
| 65–71  | cycle 7 — **approval apr-0002**, summary comment posted      |
| 72–74  | model stops · **verifier says not done** — no spec recorded  |
| 75–79  | cycle 8 — the gap addressed, spec written                    |
| 80–82  | model stops · **verifier says done**, with one limitation    |
| 83     | end — `done`, exit 0                                         |

Eight cycles, two approvals, one refusal, one failed verification and one retry. About ten model
calls and roughly fifty cents.

Everything above is reconstructible from the file alone:

```bash
aqa replay .aqa/runs/20260914T034436Z-a69f71a5
```

No network, no model, no tool calls. That is the property the whole design is arranged around.
