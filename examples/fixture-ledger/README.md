# Fixture ledger

`events.jsonl` is a synthetic, shape-complete run of the **story → tests → run → Test Plans**
skill: 34 events, every `kind` from the contract (PLAN §0.4) at least once, one approval
round-trip, one failed Playwright scenario, verifier `done`, exit code 0. All ids and text
are invented — nothing here came from a real Azure DevOps project.

Uses:

- **Platform track (B2–B4):** `node emit.mjs --ledger <workspace>/.aqa --delay-ms 200 --approval file`
  streams the fixture into a real ledger path, pauses at the approval and waits for the platform
  to write `decision` into `approvals/apr-0001.json`, then finishes with the fixture's exit code.
  `--approval none` skips the wait. `--exit-code 2` forces a blocked exit for error-path tests.
- **Package tests:** golden file for the ledger parser and the replay renderer.
- **Docs:** `aqa replay examples/fixture-ledger` renders it to Markdown.

Regenerate after a contract change with `node make-fixture.mjs` (never hand-edit the jsonl).
