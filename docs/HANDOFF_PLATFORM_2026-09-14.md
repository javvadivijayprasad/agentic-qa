# Platform track — what to apply, in order (2026-09-14)

**For:** the platform agent · **From:** the agentic-qa track

Two changes and then a joint run. The order matters: the second will not work until the first is
in. Detail for each lives in `HANDOFF_A8b_2026-09-14.md` and `HANDOFF_A9_2026-09-14.md`; this is the
sequence and the acceptance checks.

Pull `main` from `javvadivijayprasad/agentic-qa` first. Slice 1 is closed: story → tests → run →
test cases in Azure DevOps, ending `done` with the report posted back to the work item.

---

## Step 1 — the two contract changes from A8

### 1a. `agent.capabilities`

A third axis in `ai-quality.config.yaml`, beside `policy` and `scope`:

```yaml
agent:
  capabilities:
    test_plans: true # false when the account has no Test Plans access level
```

Optional, defaults to `{ test_plans: true }`, so existing configs still load. Keep the three axes
distinct wherever the UI shows them, because they answer different questions:

| axis           | question                          | who decides                         |
| -------------- | --------------------------------- | ----------------------------------- |
| `policy`       | what is the agent _allowed_ to do | an operator                         |
| `scope`        | _where_ may it act                | an operator                         |
| `capabilities` | what _can_ the environment do     | nobody — it is a fact, not a choice |

Collapsing `capabilities` into the other two would be a mistake a user pays for later: they would go
looking for the permission that turns test plans back on, and there isn't one.

**It changes the config hash** recorded in the `request` event, so re-pull
`examples/fixture-ledger/events.jsonl`. Still 42 events, no shape change.

### 1b. `VerifyPayload.limitations?: string[]`

Additive and optional on the `verify` event. Checks the verifier did **not** make, and why.

```json
{
  "kind": "verify",
  "payload": {
    "done": true,
    "gaps": [],
    "limitations": [
      "test suite membership — this Azure DevOps account has no Test Plans access level, …"
    ]
  }
}
```

On the run page, show these beside the result and visually distinct from gaps. A limitation is not
a failure — but a green run with limitations is not the same thing as a green run without them, and
the difference should be visible rather than inferred. `aqa replay` renders them under a **Checks
not made** heading; matching that wording keeps the two views legible together.

**Acceptance for step 1:** a config carrying `capabilities` loads; the run page renders a `verify`
event that has `limitations`; the fixture golden test passes against the re-pulled `events.jsonl`.

---

## Step 2 — drive a run without a terminal

```
aqa run "Write tests for AB#1" \
  --config ai-quality.config.yaml \
  --workspace examples/sandbox \
  --approval file \
  --approval-timeout 120
```

The run announces each approval in the ledger, writes a request file, and waits. Two files:

- **Ledger** — `.aqa/runs/<runId>/events.jsonl`, one JSON object per line, flushed per event. Tail
  it. Watch for `kind: "approval_requested"`, whose payload carries `approvalId`, `summary`, `calls`.
- **Request** — `.aqa/runs/<runId>/approvals/<approvalId>.json`, `decision: null` until answered.
  Write the same object back with `decision` set to `"approved"` or `"denied"` and `by` set to the
  reviewer. `at` fills itself in if omitted.

Four things to get right, each of which has a test on our side:

1. **The ledger event lands before the file exists.** The loop appends `approval_requested` and
   _then_ the approver writes the file. Polling the instant the event arrives will sometimes find
   nothing. Treat that as still arriving, not as an error — this is a once-in-fifty-runs race that
   otherwise gets blamed on something unrelated.
2. **A partial write is survivable.** Unparseable content is skipped and polling continues. Write
   to a temp file and rename anyway; it costs nothing.
3. **Silence is a no.** Past `--approval-timeout` (default 1800s) the answer becomes
   `{ decision: "denied", by: "timeout" }` and the run ends `blocked`, exit 2. An unattended run
   must not sit forever holding a browser and two MCP servers open.
4. **One approval, many calls.** Every gated call in a cycle is batched into a single request —
   that is why `calls` is an array. Render all of them. "Create 4 test cases" as one decision is the
   design; four separate prompts is what it exists to avoid.

### Exit codes

| status    | exit | show                                                             |
| --------- | ---- | ---------------------------------------------------------------- |
| `done`    | 0    | the result, plus `limitations` if present                        |
| `error`   | 1    | the `end` summary                                                |
| `blocked` | 2    | the verifier's gaps, or approval denied, or the no-progress stop |
| `refused` | 3    | scope refusal — nothing was spent                                |
| `budget`  | 4    | which budget, and the counts                                     |

---

## Run it twice

The first run is the obvious one. **The second run is the one that matters**, and it is the case a
run page is most likely to get wrong.

With the story's tests already written and its cases already linked, the agent creates nothing. It
reads the story, sees four cases already linked by `Tested By`, runs the suite, and posts a summary.
One approval. No new artefacts. Status `done`.

A page built on the assumption that every run produces something will render that as empty or
broken — and in real use it is the common case, because most runs happen after the first one. The
honest rendering is roughly: _"nothing needed changing; here is what was checked and what already
existed."_

What a real second run posted to work item 1 this morning:

```
## agentic-qa run `20260914T142818Z-23dd15d7`

**Suite: green** — 5 passed, 0 failed, 0 skipped.

**Test cases linked to work item 1: 4** (already present: 25, 26, 27, 28).

**Checks not made in this environment:**
- test suite membership — this Azure DevOps account has no Test Plans access level, so the
  cases are linked to the story but no suite contains them

_Counted from the run ledger, not from the agent's account of its own work._
```

Every figure there is counted from observed events by an in-process tool, not written by the model.
If the run page ever disagrees with that comment, the run page is wrong — both read the same ledger.

---

## What the agentic-qa track still owes you

Nothing blocking. Open items, for visibility:

- The Juice Shop fixture is not durable — the container is `--rm` and the test account dies with
  it. Fine for an attended smoke; a blocker for anything scheduled.
- Prompt caching. Every cycle re-sends the tool schemas, most of the ~$0.50 a run costs.

## Questions worth raising back

If anything in the ledger is awkward to render, say so now rather than working around it. The event
shapes are a MAJOR version bump to change, so the cheap moment to get them right is before A10 tags
a release.
