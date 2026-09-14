# Adopting this in a team

What has to change on your side, who has to do it, and in what order.

[USAGE.md](USAGE.md) covers one person running one story. This is about a team putting it into a
sprint — which is mostly not a technical problem.

---

## What you are signing up for

A tool that reads your acceptance criteria **literally** and writes tests from them. That is the
whole value and also the whole cost: it is an amplifier of requirement quality, not a substitute for
it. Teams that adopt this successfully spend their first month writing better acceptance criteria,
and get better tests as a side effect. Teams that don't, get tests that faithfully encode a vague
requirement.

Nothing here is irreversible. It writes test cases and comments in Azure DevOps and files in one
folder. It cannot delete, cannot edit a story, cannot touch a protected branch. Worst case you
delete some work items and stop using it.

---

## Three preconditions, in order of how much they matter

Check these before anyone installs anything. If two of the three are missing, fix them first — the
tool will not rescue you and you will conclude, wrongly, that it does not work.

### 1. Acceptance criteria that say something

**Bad:** "User can log in."
**Workable:** "A registered user who submits their correct email and password is signed in and sees
their email address in the account menu. An incorrect password shows 'Invalid email or password.'
and does not reveal which field was wrong."

The second produces four tests. The first produces one test that asserts almost nothing.

**How to check:** take three stories from your last sprint and ask someone who did not write them to
list the tests each implies. If they can't, neither can this.

**Who fixes it:** whoever writes the stories. This is the highest-leverage change on the list and it
pays off with or without the tool.

### 2. Stable selectors

The agent finds real selectors by reading the rendered page. If your UI is generated class names,
it will produce tests that pass today and break on the next build, and the tests will be blamed.

**How to check:** open your main flow in devtools. Can you identify each key control by something
that isn't a hashed class or a deep CSS path?

**Who fixes it:** front-end devs. Add `data-testid` to the controls in your top three flows. A week
of work, and it makes hand-written tests better too.

### 3. A test environment with a disposable account

A user in an environment you control, whose data can be wrecked without anyone caring. Not a real
customer. Not an admin.

**How to check:** can you name the account and the environment right now? If it takes a conversation,
that is the work.

**Who fixes it:** whoever owns environments. This is where most test automation efforts die, agent or
no agent.

---

## Decisions the team has to make

These have defaults, but they are yours to set — and the defaults are conservative on purpose.

| decision                              | default                          | consequence of changing it                                                           |
| ------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Who approves Azure DevOps writes?     | whoever runs it, at the terminal | Naming one person keeps the test-case backlog coherent; anyone-can-approve does not  |
| Does creating test cases need an ask? | yes (`write_record: ask`)        | Setting it to `execute` makes unattended runs possible and removes the safety catch  |
| Which work items are in scope?        | an explicit list                 | Ranges (`"100-199"`) scale; `[]` means nothing runs                                  |
| Where do generated tests live?        | a workspace folder you choose    | In the app repo they get reviewed; in a separate repo they get forgotten             |
| Are generated tests committed?        | your call                        | Committing them means PR review; not committing means they are disposable            |
| Who pays for the API key?             | unset                            | One team key with a budget alert beats five personal keys                            |
| Are ledgers kept?                     | written to `.aqa/`, git-ignored  | Archiving them gives you an audit trail; dropping them means failures are unreadable |

The one worth real discussion is **who approves**. The approval prompt is the point at which a human
takes responsibility for what lands in your tracker. If that becomes a rubber stamp by whoever is
nearest, you have the governance machinery and none of the governance.

---

## Setup, by role

### Azure DevOps administrator — 15 minutes

1. A **PAT** with **Work Items (read & write)**. That is the whole scope for the default setup.
   Add **Test Management (read & write)** only if your organisation has the Test Plans access level.
2. Decide whether it goes in a shared secret store or each user creates their own. Shared is easier
   to revoke; per-user is easier to attribute. Per-user is the better default — the ledger records
   the approver, and matching that to an identity is useful later.
3. Nothing else. No extension to install, no service hook, no project setting.

**If you do not have the Test Plans access level** — most teams on Basic do not — set
`capabilities.test_plans: false` and everything else works. Test cases are ordinary work items;
plans and suites are the paid service. The run records what it could not check rather than failing.

### QA lead — an hour, once

1. `npm install -g @vijaypjavvadi/agentic-qa`
2. Write `ai-quality.config.yaml` and commit it **to the repo**, not to someone's laptop. It is the
   team's policy, and it should be reviewed like any other policy.
3. Create the workspace: a folder with a `playwright.config.ts` whose `baseURL` comes from
   `AQA_APP_URL`. See [USAGE.md](USAGE.md).
4. Run `--dry-run` and read the output with the team. It prints every tool the agent could reach and
   what the policy table would do with it. Fifteen minutes here removes most of the anxiety.

### Developers — a week, spread out

Add `data-testid` to the controls in your main flows. That is the entire ask.

### Whoever writes stories — ongoing

Write acceptance criteria that a stranger could turn into tests. You will find out very quickly
which ones don't, because the generated tests will be thin and obviously so.

---

## Rolling it out

**Week 1 — one story, one person, watching.**
Pick a story with genuinely good criteria and a flow that already has test ids. Run it at the
terminal. Read the ledger afterwards with `aqa replay`. The goal is not coverage; it is for one
person to be able to explain to the team exactly what happened.

**Week 2 — five stories, still attended.**
Vary them deliberately: one with weak criteria, one with a flow that has no test ids. You are
mapping where it fails, and both of those failures are informative rather than embarrassing.

**Week 3 — decide the process.**
By now you know whether generated tests get committed, who approves, and whether the criteria need
work. Write it down in the config and in your team's definition of done.

**Steady state.**
A story is accepted → someone runs it → twenty minutes later there is a suite that already passes,
and a test case linked to the story. Re-running later creates nothing; it just re-verifies.

Resist scaling before week 3. The failures you find in week 2 are cheap; the same failures across
forty stories are a cleanup project.

---

## What actually changes in how you work

**A review step replaces a writing step.** Someone still reads every generated test. That is not a
failure of the tool — reviewing a suite that runs is a different and much smaller job than writing
one from an empty file.

**"Is this story tested?" becomes a query.** Every test case is linked to its story by a *Tested By*
relationship. That is data, not a spreadsheet someone maintains.

**Your acceptance criteria get better.** Not because anyone mandates it, but because a vague
criterion now visibly produces a vague test, in front of the whole team.

**Failures become readable.** Every run leaves a ledger. "Why did it do that?" has an answer that
does not depend on anyone's memory.

---

## Guardrails worth setting on day one

**One named approver per project.** Not a rule the tool enforces — a rule you enforce. The ledger
records who approved what, which makes it reviewable.

**A budget alert on the API key.** A story costs about fifty cents. A misconfigured loop costs more.
`budgets.steps` caps a single run; an alert catches the pattern.

**Archive the ledgers of runs that mattered.** They contain no secrets — prompt text is never stored
and credentials are redacted — so they can go in a build artefact or attached to a ticket. The first
time you need to explain an agent's behaviour to someone who wasn't there, you will want it.

**Keep `destructive: refuse`.** If someone proposes relaxing it, ask which specific operation they
need and classify that one instead.

---

## How this fails in a team

Each of these is recoverable; all are cheaper to avoid.

**Approvals become a rubber stamp.** Someone approves four test cases a day without reading them,
and the backlog fills with near-duplicates. Fix: one named approver, and review the test cases
weekly for the first month.

**Generated tests are never reviewed, then never trusted.** A suite nobody has read is a suite
nobody believes when it goes red. Fix: treat them like any other code — a PR.

**It gets pointed at a legacy flow with no test ids, and blamed.** Fix: it is not a strategy for
your worst screen. Start where you would start by hand.

**Someone relaxes `write_record` to `execute` for convenience.** Now nothing asks, and the first
time a run misfires you have fifty work items to delete. Fix: if you want unattended runs, do it
deliberately with file approval and a named reviewer, not by removing the question.

**One person owns it and then leaves.** Fix: the config is in the repo, the docs are in the repo,
and the ledgers explain the runs. That is the point of all three.

---

## Checklist

```
Preconditions
[ ] acceptance criteria on at least one story are test-derivable
[ ] the target flow has data-testid on its key controls
[ ] a disposable test account exists in an environment we control

Setup
[ ] PAT with Work Items (read & write)
[ ] capabilities.test_plans set correctly for our licence
[ ] ai-quality.config.yaml committed to the repo
[ ] workspace folder with playwright.config.ts reading AQA_APP_URL
[ ] --dry-run output reviewed with the team

Decisions
[ ] named approver
[ ] generated tests: committed or not
[ ] work item scope: list or range
[ ] API key ownership and budget alert

Rollout
[ ] week 1: one story, attended, ledger read afterwards
[ ] week 2: five varied stories, failures mapped
[ ] week 3: process written into the definition of done
```
