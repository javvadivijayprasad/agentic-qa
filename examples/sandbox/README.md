# Sandbox workspace

The workspace the agent is pointed at for the slice-1 run:

```
node dist/cli.js run "Write tests for AB#1" \
  --config examples/ai-quality.config.yaml \
  --workspace examples/sandbox
```

Everything the agent writes — feature files, generated specs, Playwright output —
lands inside this folder and nowhere else. `fs.write_file` and `bdd2pw.to_spec`
are bounded to the workspace root, so a run cannot touch the package's own
source even if the model asks it to.

## What is here

| path | role |
|---|---|
| `features/login.feature` | Seed feature for AB#1, kept so the adapters can be exercised without Azure DevOps. A real run regenerates this from the work item. |
| `playwright.config.ts` | `baseURL` from `AQA_APP_URL`; `testDir: tests`. |
| `tests/` | Generated specs. Created by the run; not checked in. |

## The application under test

OWASP Juice Shop, pinned by image rather than built from source:

```
docker run --rm -d -p 3100:3000 --name juice-shop bkimminich/juice-shop
```

Set `AQA_APP_URL`, `AQA_APP_USER` and `AQA_APP_PASS` in `.env` at the repo root.
The credentials belong to a disposable account registered in the container; the
container is `--rm`, so the account disappears with it.

Juice Shop pops "challenge solved" banners that reposition the page and can
swallow clicks. For a deterministic run, mount a config with
`challenges.showSolvedNotifications: false` and start the container with
`NODE_ENV` pointing at it.

## Running the suite by hand

```
cd examples/sandbox
npx playwright test              # needs @playwright/test at the repo root
npx playwright test --reporter=json
```

The second form is what `pw.run_tests` shells out to.
