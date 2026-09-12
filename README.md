# @vijaypjavvadi/agentic-qa

> A standalone agentic QA runtime: a model chooses tools over the Model Context Protocol (MCP)
> inside a governance gate, a code verifier decides "done", and every step is written to a
> replayable ledger.

**Status: v0.1 in progress.** Steps A0–A1 of the implementation plan are done: package
scaffold, contract types, append-only ledger, `aqa replay`, and the fixture ledger the
TestForge platform builds against. The agent loop, gate, MCP client, skills and verifier
arrive in A2–A8. Nothing here calls a model or a tool yet.

## What it will do (slice 1)

```
aqa run "Write and run tests for AB#1, then record the results in Azure Test Plans." \
  --config ai-quality.config.yaml --ledger .aqa --approval terminal
```

1. Read the work item and its acceptance criteria (Azure Boards, via Microsoft's Azure DevOps MCP server).
2. Read the relevant source files (Azure Repos) — source before requirement text.
3. Generate Gherkin scenarios tagged `@ac:<id>` (TestForge TCG adapter).
4. Scaffold Playwright specs (`bdd2pw` adapter) and run them (Playwright MCP server).
5. Ask for approval, then create test cases and a test run in Azure Test Plans.
6. A **code** verifier checks every acceptance criterion has a scenario, every scenario ran,
   and Test Plans matches the results. The model never grades itself.

Exit codes: `0` done · `2` blocked (verifier gaps) · `3` refused by the gate · `4` budget · `1` error.

## What works today

```bash
npm ci
npm run typecheck && npm test && npm run build
node dist/cli.js replay examples/fixture-ledger            # Markdown to stdout
node dist/cli.js replay .aqa --out report.md              # latest run under a ledger root
node examples/fixture-ledger/emit.mjs --ledger /tmp/x --approval file   # for the platform team
```

## Ledger

`<ledger>/runs/<runId>/events.jsonl` — append-only JSON lines, flushed per event, never
rewritten. Envelope (shared with the pw-extensions `RunEvent` shape):

```json
{ "tool": "agentic-qa", "runId": "…", "eventId": 17, "timestamp": 1789228803550,
  "kind": "policy", "payload": { "toolName": "ado.create_test_cases", "class": "write_record",
  "decision": "ask", "reason": "write to Test Plans requires approval", "approvalId": "apr-0001" } }
```

Kinds: `request` `plan` `context` `inference` `policy` `approval_requested` `approval_resolved`
`call` `observation` `verify` `end`. Payload shapes are in `src/types.ts`; the `context` event
records hashes and token counts only, never content. `aqa replay` renders a ledger with zero
network and zero tool calls — every number in a report traces to an event id.

## Governance defaults

| class | default |
|---|---|
| read | execute |
| write_workspace | execute |
| write_branch | ask |
| write_record | ask |
| destructive | refuse |

Scope (work items, repos, test plans, writable branches) is an allow-list in
`ai-quality.config.yaml`; anything outside it is refused and logged.

## Conventions

TypeScript `strict`, ESM + CJS via tsup, vitest, ESLint flat config, Prettier, MIT,
`@vijaypjavvadi` scope, no network by default, JSONL events in a dot-folder — the same family as
`bdd2pw`, `pw-emit`, `pw-self-heal`, `tps-tool`, `synthdata`.

## Citation

See `CITATION.cff`. Author: Vijay Prasad Javvadi, Independent Researcher, Plainsboro, NJ, USA
(ORCID 0009-0004-1192-6906).

## License

MIT
