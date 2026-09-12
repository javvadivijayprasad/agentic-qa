// Regenerates events.jsonl from scenario.ts. Run: npm run fixture:make
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDir, LEDGER_FILE } from "../../src/ledger/ledger.js";
import { FIXTURE_RUN_ID, runFixtureScenario } from "./scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "aqa-fixture-"));
const result = await runFixtureScenario(tmp);
const src = join(runDir(tmp, FIXTURE_RUN_ID), LEDGER_FILE);
const dst = join(here, "events.jsonl");
copyFileSync(src, dst);
rmSync(tmp, { recursive: true, force: true });
console.log(
  `wrote ${result.events} events to ${dst} (status ${result.status}, exit ${result.exitCode})`,
);
