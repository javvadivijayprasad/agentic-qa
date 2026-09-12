# Changelog

All notable changes to this project will be documented in this file. Format: Keep a Changelog;
versioning: SemVer. Any change to the contract (PLAN §0: CLI flags, exit codes, env vars,
config schema, ledger event shapes, approval file mode, artefact paths) is a MAJOR bump.

## [Unreleased] — 0.1.0-dev.0

### Added (A0 — scaffold)
- Package scaffold: `@vijaypjavvadi/agentic-qa`, TypeScript strict, tsup (ESM+CJS+d.ts), vitest,
  ESLint flat config, Prettier, MIT, CITATION.cff, SECRETS-CHECKLIST.md, CI matrix (node 18/20 ×
  ubuntu/windows).

### Added (A1 — types, ledger, replay, fixture)
- `src/types.ts`: contract types — 11 event kinds, 5 policy classes, decisions, run status and exit
  codes, config schema, `Skill` and `Verifier` interfaces.
- `src/ledger/ledger.ts`: append-only JSONL `Ledger` (flush per event, resume-safe numbering),
  strict parser with line-numbered `LedgerFormatError`, monotonic/same-run checks.
- `src/ledger/replay.ts`: `renderLine` (stable one-liners for the platform run page),
  `computeStats`, `renderMarkdown`.
- `src/cli.ts`: `aqa replay <path> [--out]`, `--version`, `--help`; `aqa run` stubbed until A2.
- `examples/fixture-ledger/`: 34-event synthetic story→tests→Test Plans run covering every kind,
  `make-fixture.mjs` generator, `emit.mjs` streamer with `--approval file` wait for the platform
  track, README.
- Tests: 27 (ledger, parser, replay, CLI).
