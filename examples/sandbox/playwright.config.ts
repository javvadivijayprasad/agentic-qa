import { defineConfig, devices } from "@playwright/test";

/**
 * The agent's workspace for the sandbox run (PLAN §1 A8).
 *
 * The application under test lives at `AQA_APP_URL` — OWASP Juice Shop on
 * localhost by default. The address is HERE and nowhere else: generated specs
 * navigate relatively (`page.goto("/#/login")`) so that the same suite runs
 * against a different host without editing a single test. Credentials come from
 * the environment for the same reason, and because a password in a spec file is
 * a password in git.
 */
export default defineConfig({
  testDir: "tests",
  // The agent runs this suite through `pw.run_tests`, which reads the JSON
  // reporter from stdout. Keep retries at 0: a flaky pass is worse than a
  // failure here, because the verifier treats green as evidence.
  retries: 0,
  reporter: process.env["CI"] ? "line" : "list",
  use: {
    baseURL: process.env["AQA_APP_URL"] ?? "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
