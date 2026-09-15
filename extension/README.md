# Agentic QA for VS Code

Run the [agentic-qa](https://github.com/javvadivijayprasad/agentic-qa) runtime from the editor,
approve its writes in a dialog instead of a terminal prompt, and read the ledger it leaves behind.

The runtime does the work. This extension exists for the two things an editor does better than a
terminal: **collecting an approval properly**, and **making a run's evidence readable**.

## What it adds

**An approval dialog.** The runtime's `--approval file` mode writes each batch of gated calls to
`approvals/<id>.json` and waits. This extension watches for that file and shows you the batch — every
call, every argument — as a modal.

Two properties are deliberate and not configurable:

- **Dismissing the dialog denies.** Escape, clicking away, closing the window: all deny.
- **Approve is never the default button.** An approval you can collect by pressing Enter is not an
  approval.

If you need longer to decide, choose **Open the request** — the run keeps waiting until
`aqa.approvalTimeoutSeconds` elapses, and the status bar will re-ask.

**A runs view.** Every run in `.aqa/runs/`, newest first, with its status and event count. Expand one
to see its events in order; click an event to open the recorded JSON. This is the same evidence
`aqa replay` renders, browsable rather than printed.

## Commands

| command                                  | does                                                       |
| ---------------------------------------- | ------------------------------------------------------------ |
| `Agentic QA: Run story for work item…`   | prompts for a work item id, then runs with file approval     |
| `Agentic QA: Dry run`                    | prints every reachable tool and its gate class; spends nothing |
| `Agentic QA: Replay a run as Markdown`   | opens the rendered run report                                |
| `Agentic QA: Show runtime version`       | reports which `aqa` was found, and where                     |

Start with the dry run. It makes no model calls and no tool calls, and it answers "what could this
thing do in my repository?" before you spend anything finding out.

## Requirements

The runtime is **not bundled**. The extension looks for `aqa` in this order:

1. `aqa.executablePath`, if you set it
2. `node_modules/.bin/aqa` in the workspace folder
3. `aqa` on your `PATH`

If none is found it offers to run `npm install -g @vijaypjavvadi/agentic-qa` in a terminal, where you
can see and stop it.

They are versioned separately on purpose. The ledger event shapes are a contract, and someone pinning
an older runtime should not be forced to upgrade it because the editor integration changed.

You also need what the runtime needs: a `.env` with your credentials, an `ai-quality.config.yaml`,
and a workspace folder with a `playwright.config.ts`. See
[USAGE.md](https://github.com/javvadivijayprasad/agentic-qa/blob/main/docs/USAGE.md), and
[ADOPTION.md](https://github.com/javvadivijayprasad/agentic-qa/blob/main/docs/ADOPTION.md) if you are
introducing this to a team.

## Settings

| setting                       | default                   | what it is                                    |
| ----------------------------- | ------------------------- | ----------------------------------------------- |
| `aqa.executablePath`          | _(empty)_                 | absolute path to `aqa`; empty means search       |
| `aqa.configFile`              | `ai-quality.config.yaml`  | policy config, relative to the workspace folder |
| `aqa.workspaceDir`            | `qa`                      | the only folder the agent may write to          |
| `aqa.ledgerDir`               | `.aqa`                    | ledger root; runs live in `<ledgerDir>/runs/`   |
| `aqa.approvalTimeoutSeconds`  | `1800`                    | silence past this counts as **denied**          |

## What it does not do

It does not edit `ai-quality.config.yaml`. That file is your policy — what the agent may do and
where — and it belongs in the repository under review like any other policy, not behind a settings
form that makes it feel like a preference.

## License

MIT.
