# Secrets checklist

Run through this before every commit and every release.

- [ ] `.env` is not staged (`git status` shows nothing under `.env`); `.gitignore` covers `.env` and `.env.*` except `.env.example`.
- [ ] `.env.example` contains placeholders only — no real PAT, no real API key.
- [ ] No Azure DevOps PAT, Anthropic key, or bearer token appears in `src/`, `test/`, `examples/`, `docs/`, or `.aqa/` fixtures (`git grep -i -E "pat=|api_key|sk-ant|bearer "`).
- [ ] Fixture ledgers under `examples/` carry synthetic ids and text only.
- [ ] The ledger writer never records env var values; the `context` event records hashes and token counts, not content.
- [ ] Log output masks PATs and keys (first 4 chars + `…`).
- [ ] Azure DevOps PAT scopes are least-privilege: Work Items R/W, Test Management R/W, Code Read, Build Read. Rotate every 90 days.
