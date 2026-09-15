# Changelog — Agentic QA for VS Code

The extension and the runtime version independently. This file covers the extension only; the
runtime's own changes are in the repository root `CHANGELOG.md`.

## [0.1.0] — unreleased

First version. Two capabilities, chosen because a terminal does them badly.

### Added

- **Approval dialog** over the runtime's existing `--approval file` contract. Watches
  `<ledgerDir>/runs/*/approvals/*.json` for a record with `decision: null`, shows the whole batch —
  every call and every argument — and writes the answer back as `approved` or `denied` with
  `by: "vscode:<user>"`.
  - Dismissing the dialog denies. So does failing to write the decision, which the run sees as a
    timeout; the extension says so rather than letting you believe you approved something.
  - Approve is never the default button.
  - **Open the request** opens the JSON and leaves the approval pending, with a status bar item to
    re-ask. Reading four arguments properly is worth more than answering quickly.
- **Runs view** listing `.aqa/runs/` newest first with status and event count, expanding to the
  event sequence; clicking an event opens the recorded JSON. Refreshes while a run is writing.
- **Commands**: run a story, dry run, replay, show runtime version.
- **Runtime discovery** — `aqa.executablePath`, then the workspace's `node_modules/.bin`, then
  `PATH`; offers a global install in a visible terminal when nothing is found.
- Exit codes are reported for what they mean: `2` blocked and `3` refused are the governance
  machinery working, not failures, and are reported as warnings rather than errors.

### Deliberately absent

- **No config editor.** `ai-quality.config.yaml` is the team's policy and belongs in the repository
  under review, not behind a settings form that makes it read like a preference.
- **No bundled runtime.** The ledger event shapes are a contract; pinning the runtime to the
  extension's release cycle would force an upgrade on anyone relying on them.
