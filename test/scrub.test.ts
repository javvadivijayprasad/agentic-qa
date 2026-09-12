import { describe, it, expect } from "vitest";
import { mask, scrub } from "../src/governance/scrub.js";

describe("scrub", () => {
  const cases: Array<[string, string, RegExp]> = [
    [
      "anthropic key",
      "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      /\[ANTHROPIC_KEY:sk-a…\]/,
    ],
    ["aws key", "id AKIAIOSFODNN7EXAMPLE end", /\[AWS_KEY:AKIA…\]/],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD", /\[GITHUB_TOKEN:ghp_…\]/],
    [
      "bearer",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc",
      /Bearer \[TOKEN\]/,
    ],
    [
      "basic auth url",
      "https://vijay:hunter22@dev.azure.com/org",
      /https:\/\/vijay:\[PASSWORD\]@dev\.azure\.com/,
    ],
    ["pat assignment", "AZURE_DEVOPS_PAT=abcdefghijklmnop1234", /AZURE_DEVOPS_PAT=\[REDACTED\]/],
    ["password assignment", 'password: "S3cretPassw0rd!"', /password: "\[REDACTED\]/],
    ["ado pat 52", "x " + "a1b2c3d4e5".repeat(5) + "ab" + " y", /\[PAT:a1b2…\]/],
    ["email", "contact jvijayprasad@gmail.com now", /contact \[EMAIL\] now/],
    ["ipv4", "server 66.55.65.18 up", /server \[IP\] up/],
    ["ssn", "ssn 123-45-6789", /ssn \[SSN\]/],
    ["card", "card 4111 1111 1111 1111", /card \[CARD\]/],
  ];
  for (const [name, input, expected] of cases) {
    it(`redacts ${name}`, () => {
      const r = scrub(input);
      expect(r.text).toMatch(expected);
      expect(r.redactions.length).toBeGreaterThan(0);
    });
  }

  it("leaves ordinary text and code alone", () => {
    const text =
      "Given a user on the login page, when they click Sign in, then AC-1 passes. version 1.2.3 port 4100";
    const r = scrub(text);
    expect(r.text).toBe(text);
    expect(r.redactions).toEqual([]);
  });

  it("reports counts per rule", () => {
    const r = scrub("a@b.io and c@d.io from 10.0.0.1");
    expect(r.redactions).toEqual([
      { rule: "email", count: 2 },
      { rule: "ipv4", count: 1 },
    ]);
  });

  it("never leaks the secret in the redaction summary", () => {
    const r = scrub("AZURE_DEVOPS_PAT=supersecretvalue123456");
    expect(JSON.stringify(r.redactions)).not.toContain("supersecret");
  });
});

describe("mask", () => {
  it("shows at most 4 characters", () => {
    expect(mask("abcdefgh")).toBe("abcd…");
    expect(mask("ab")).toBe("…");
    expect(mask(undefined)).toBe("(unset)");
  });
});
