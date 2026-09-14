# Architecture

Why this is built the way it is, and what each choice cost.

This document is about decisions rather than components — for the parts and their contracts, see
[TECHNICAL.md](TECHNICAL.md). Most of what follows was not designed up front. It was arrived at by
running the thing against a live Azure DevOps project and a real application, reading the ledger
afterwards, and finding out that the assumption underneath some piece of it was wrong. Those
episodes are recorded here with the decision each produced, because a design without its failures
reads as more inevitable than it was.

---

## 1. The problem

Acceptance criteria are written, and then — usually weeks later — someone turns them into automated
tests from memory. The mapping between a requirement and the test that covers it is maintained by
hand, decays quietly, and cannot be queried. "Is this story tested?" takes a person an afternoon and
the answer is a judgement call.

An agent can close that gap. It can also, with the same credentials, delete a branch, rewrite the
acceptance criteria it is being judged against, or report a success it did not achieve. So the
design problem is not "can a model write a Playwright test" — it can — but:

> Can you let a model near a team's issue tracker and still prove, afterwards, exactly what it did,
> what it was allowed to do, and whether the work is actually finished?

Everything below follows from taking that question as the primary one.

---

## 2. The model proposes; code disposes

**Decision.** The model's only output is a proposal: which tool to call, with which arguments. It
never executes anything. A governance gate — ordinary code, driven by a policy table the operator
owns — decides `execute`, `ask`, or `refuse`.

**Why.** The alternative is prompt-based restraint: tell the model what not to do and hope. That
fails in two ways. It is unfalsifiable, because you cannot tell a restrained model from a lucky one.
And it degrades silently — a longer context, a different model version, an unusual phrasing, and the
instruction stops binding. A classification table does not have moods.

**The consequence that matters most:** an unclassified tool is `destructive`, and `destructive`
refuses. New capability is invisible until someone writes it down. That is the opposite of the usual
default and it is the single most important line in the system.

**What it costs.** Every new tool needs a manifest entry, which is friction, and a wrong entry is
a real hazard — the manifest is the trusted base. It also means the agent sometimes cannot do an
obviously reasonable thing because nobody classified it yet. That is the correct failure direction.

### Per-action classification

**Decision.** Classification is per _operation_, not per tool: `ado.testplan#list_plans` and
`ado.testplan_test_plan_write#create` are separate entries.

**Why — and this was a discovery, not a plan.** Microsoft's Azure DevOps MCP server multiplexes many
operations behind one tool name and an `action` argument. `wit_backlog` both lists a backlog and
reorders it. Classifying by tool name would have forced a choice between refusing the read and
permitting the write. Both are wrong.

An action the manifest does not name is refused exactly like an unknown tool.

---

## 3. The ledger is the memory, not a log

**Decision.** Every cycle is assembled fresh from the ledger. The runtime never holds an open
conversation with the model — no accumulating `tool_result` history on the API side.

**Why.** It makes a run replayable. `aqa replay` renders any run with no network and no tool calls,
and every number in the report traces to an event id. More importantly it makes the run _auditable
in the strong sense_: whatever shaped a decision is in the file, because the file is the only thing
that shaped it. A conversation-based agent can always have been influenced by something that was
never written down.

**What it costs — and this one bit.** The model has no memory between cycles. Early runs would
propose an action, complete it, and then propose the identical action again, because the input was
identical. The fix is to feed the model's own notes forward (`NOTE_WINDOW = 4`). That is not free:
the notes are the model's words, and they enter the context as the model's words, which is a small
crack in "the ledger is the only source of truth". It is a deliberate, bounded one.

### What the ledger does not contain

`context` events record section hashes and token counts, never prompt text. Secrets are scrubbed on
the way to the model and on the way to the ledger. The Azure DevOps token is passed through a child
process environment, never on a command line, where it would appear in a process listing.

The result is a file you can attach to a ticket, hand to an auditor, or check into a repository
without a second thought. That property is worth more than the convenience of storing the prompts.

---

## 4. The model does not decide "done"

**Decision.** When the model believes the work is complete it stops proposing calls. That claim is
recorded — and then ignored. A verifier, which is ordinary code, reads the ledger and checks that
specific things were _observed to happen_.

**Why.** A model asked whether it succeeded is being asked to evaluate its own output against its
own understanding of the goal, with no independent evidence. It will often be right, which is worse
than being consistently wrong, because it means the failures are rare and surprising.

Keeping both is deliberate: the model's claim sits in the ledger next to the verifier's verdict, and
**the two disagreeing is the most informative artefact a failed run produces**.

### Checks ask what is TRUE, not what this run did

The verifier's checks originally asked "did this run create a test case?", "did this run write a
spec?". Both were wrong, in the same way, and it took a working run to see it.

A run that found a correct spec already in the workspace and simply executed it was told "no spec
written" — and the agent rewrote a correct file to satisfy the check. A run over a story whose tests
already existed was _required_ to create test cases, so three consecutive runs each filed a fresh
set of duplicates against the same story.

**Decision.** Checks assert state, not effort. A spec that exists counts however it got there. Cases
already linked to the story count. A re-run that changes nothing verifies as done.

**The generalisation**, which is the useful part: _a verifier that demands work will get work, and
some of that work will be damage._

### Where judgement stays with the model

Deduplication needs a key. Test case titles are not one — the model rewords them every run. And the
Azure DevOps case-creation API exposes no tag and no automated-test-name field to key on. So
"is this acceptance criterion already covered?" is a semantic judgement, and the model makes it.

What code insists on is narrower and checkable: **if you created anything, you read the existing
cases first.** Code enforces the discipline; the model exercises the judgement; the ledger records
both. Where a deterministic check is impossible, the honest move is to check the thing that _is_
deterministic rather than to fake one.

---

## 5. Look, don't touch

**Decision.** The agent may `navigate`, `snapshot`, `find`, `wait_for`, `screenshot`, and read the
console and network. `click`, `type`, `fill_form`, `press_key`, `select_option`, `hover`, `drag`,
`drop`, `file_upload` and `handle_dialog` are never classified, so they cannot be called.
`browser_evaluate` and `browser_run_code_unsafe` are never classified at all.

**Why.** A single-page application's selectors exist only in the rendered DOM, so the agent has to
look at the running app — reading the source is not enough. But an agent that can _operate_ the
application can change its state and then assert against the state it created, which is a test that
passes and proves nothing. It can also take expected behaviour from what the app does rather than
from what the requirement says, which is the difference between testing a specification and
describing an implementation.

So the only thing that ever interacts with the application under test is the suite the agent wrote,
executed by Playwright.

**What it costs.** The agent cannot reach a page that requires interaction to arrive at — a wizard's
third step, for example. If a run ever blocks for that reason it is a finding worth having, and the
policy gets relaxed deliberately rather than by default.

---

## 6. Three axes, not one

`policy`, `scope` and `capabilities` are separate config dimensions:

| axis           | question                          | who decides                         |
| -------------- | --------------------------------- | ----------------------------------- |
| `policy`       | what is the agent _allowed_ to do | an operator                         |
| `scope`        | _where_ may it act                | an operator                         |
| `capabilities` | what _can_ the environment do     | nobody — it is a fact, not a choice |

The first two were designed. The third was forced by a finding.

**The finding.** In Azure DevOps, creating a test _case_ is an ordinary work-item write and succeeds
on a Basic licence. Creating a test _plan_ or _suite_ goes through the Test Plans service, which
requires the Test Plans access level — a paid extension. Without it, every attempt returns
`You are not authorized to access this API`, while `list_plans` keeps succeeding and returns an
empty list.

The boundary does not fall between "Test Plans works" and "Test Plans doesn't". It runs straight
through the middle of the feature, and it is not documented anywhere obvious.

**Why it needed its own axis.** The obvious move is to fold it into `policy` — "test plan writes:
refuse". That would be a lie with consequences: an operator reading it would go looking for the
permission that turns it back on, and there isn't one. `capabilities` says _this account cannot do
this_, which is a different kind of statement from _this agent may not do this_, and users pay later
for the conflation.

With `test_plans: false`, the plan and suite tools are removed from the model's view entirely. An
environment that cannot perform an operation should not advertise it, or the run spends its budget
discovering that.

### Limitations are recorded, not dropped

The verify event carries `limitations`: checks that were **not** made, and why. A run can be done
without being complete, and that difference belongs in the evidence rather than in a footnote a
reader has to know to look for. A green result with a limitation is not the same object as a green
result without one.

---

## 7. Stop rules, and the cost of each

An agent that cannot make progress does not stop. It repeats itself until the budget is gone. Three
rules address that, and two of them were wrong on the first attempt.

**No progress.** A cycle whose calls were all made before has advanced nothing. It is fed back once,
then the run ends. _Observed: the same two files read twenty-nine times._

**…and its reverse.** The first version of that rule blocked the legitimate re-run of a test suite
after a spec was edited — the same call, with an entirely different meaning. The model rewrote the
same file thirteen times trying to get around it. Now a successful call that produced artefacts, or
that is not a read, clears the memo. _A rule against repetition has to know what changed._

**Closed operations.** A call can fail because the arguments were wrong — retry — or because the
environment will not perform that operation for this identity at all. No argument list fixes the
second kind. _Observed: a test plan creation attempted four times, the model varying a field between
attempts, so the exact-argument memo never fired and a human was asked to approve the same doomed
write three more times._ An authorization failure now closes that operation for the rest of the run,
**before** the approval batch is assembled.

The phrase list that recognises an authorization failure is deliberately narrow. A false positive
silently removes a capability from a run, which is a much worse failure than one wasted retry.

---

## 8. Approval is batched, and defaults to no

Every gated call in a cycle goes into a single approval request. A reviewer approving "create four
test cases" as one decision is the design; four separate prompts is the thing it exists to avoid,
because a reviewer clicking through four prompts is not reviewing.

In terminal mode the default is No — an empty answer, a closed stdin, a piped run, all deny. In file
mode, silence past a timeout becomes `denied by: "timeout"`, so an unattended run cannot sit forever
holding a browser and two MCP servers open.

---

## 9. What is deliberately absent

- **Work-item field writes.** The agent creates test cases and posts comments. It cannot update a
  work item's fields, because the acceptance criteria are what it is verified against, and an agent
  that can edit its own requirements is not auditable. This is enforced by the manifest, not by
  instructions.
- **Deletion, anywhere.** `destructive` refuses by default, and destructive-looking names are raised
  to that class regardless of how a server declares them.
- **Writing outside the workspace.** Every filesystem path resolves under one root.
- **Test run publication.** Recording a test _run_ against a test point needs the same Test Plans
  access level, so the honest position is that it is out of scope rather than half-supported.

---

## 10. Rejected alternatives

**A more capable agent with better instructions.** Faster to build, and it is what most comparable
tools do. Rejected because the resulting system cannot be audited: there is no artefact that
distinguishes "it behaved" from "it happened to behave".

**Letting the model self-report results.** The summary posted back to the work item was, for a
while, prose the model wrote about its own work — including the numbers. It was accurate both times
it was checked. It was still a claim standing where evidence belongs, and it could drift from the
ledger without anyone noticing. It is now composed by an in-process tool that counts from the
ledger; the agent posts it verbatim and may add its own commentary around it, clearly marked as
its own.

**Storing prompts in the ledger.** Would make replay perfectly faithful. Rejected: it turns every
ledger into a file that has to be handled carefully, which would destroy the property that makes
ledgers useful — that you can attach one to a ticket without thinking about it.

**A generic "AI does QA" scope.** One skill, one slice, verified end to end, beats four
half-working ones. The skill interface exists so the second slice is additive rather than a rewrite.

---

## 11. What the live runs taught

Every defect below was found by reading a ledger after a failed run. Every one was a defect in this
runtime rather than a model error — which is itself the most useful result of the exercise, and the
strongest argument for the ledger.

| observed                                             | decision it produced                                   |
| ---------------------------------------------------- | ------------------------------------------------------ |
| The same two files read 29 times                     | the no-progress stop rule                              |
| The same spec rewritten 13 times to defeat that rule | a state-changing call clears the repeat memo           |
| The story re-read endlessly                          | context windows sized by role, not one flat cap        |
| A password invented, then the demo app's admin used  | credential variables named exactly; fallback forbidden |
| A doomed write approved four times                   | authorization failures close the operation             |
| Five test cases one run, four the next               | the grain of a test case stated explicitly             |
| Three runs, three duplicate sets of cases            | checks assert state, not effort                        |
| The verifier passing no check against a real ledger  | fixtures must encode the shape the runtime writes      |

That last one is worth dwelling on. The verifier compared server-qualified tool names against the
bare names the loop actually writes, so it matched nothing and reported every check as "never
attempted" — on a run that had done all of them. It had been that way since the beginning. Two
hundred tests were green because the hand-built fixtures encoded a shape the runtime never produced.

**A fixture is a hypothesis about the real thing, and nobody had tested the hypothesis.** There is
now an end-to-end test that runs the real loop and hands its ledger to the real verifier. It is the
only test in the suite that encodes no assumption about the event shape, and it is the one that
would have caught this on day one.
