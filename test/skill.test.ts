import { describe, it, expect } from "vitest";
import {
  storyToTestsSkill,
  storyToTestsInstructions,
  STORY_TO_TESTS_TOOLS,
  STORY_TO_TESTS_SOURCES,
} from "../src/skills/story-to-tests.js";
import { DEFAULT_MANIFEST, entryClass } from "../src/mcp/manifest.js";
import { StoryToTestsVerifier } from "../src/verify/story-to-tests.js";

describe("story-to-tests skill", () => {
  const skill = storyToTestsSkill({ workItem: "1" });

  it("carries the work item into the instructions and the verifier", async () => {
    expect(skill.name).toBe("story-to-tests");
    expect(skill.instructions).toContain("work item 1");
    expect(skill.verifier).toBeInstanceOf(StoryToTestsVerifier);
    expect(skill.verifier.name).toBe("story-to-tests");
  });

  it("shows the model only tools the manifest classifies", () => {
    const unclassified = STORY_TO_TESTS_TOOLS.filter((t) => DEFAULT_MANIFEST[t] === undefined);
    expect(unclassified).toEqual([]);
  });

  it("shows no tool the gate would always refuse", () => {
    const alwaysRefused = STORY_TO_TESTS_TOOLS.filter(
      (t) => entryClass(DEFAULT_MANIFEST[t]!) === "destructive",
    );
    expect(alwaysRefused).toEqual([]);
  });

  it("declares sources that are a subset of the tools it can see", () => {
    expect(STORY_TO_TESTS_SOURCES.every((s) => STORY_TO_TESTS_TOOLS.includes(s))).toBe(true);
    expect(skill.sourceTools).toEqual(STORY_TO_TESTS_SOURCES);
  });

  it("tells the model the verifier decides done, and names every check", () => {
    const text = storyToTestsInstructions("1");
    for (const phrase of [
      "you do not decide this",
      "was read",
      "spec file exists",
      "zero failures AND zero skipped",
      "testsWorkItemId = 1",
      "added to a test suite",
      "Never hard-code the application's address",
      'process.env["AQA_APP_USER"]',
      'process.env["AQA_APP_PASS"]',
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("names only actions the manifest admits", () => {
    const text = storyToTestsInstructions("1");
    const mentioned = [...text.matchAll(/action "([a-z_]+)"/g)].map((m) => m[1]);
    const admitted = new Set(
      Object.values(DEFAULT_MANIFEST).flatMap((e) => Object.keys(e.actions ?? {})),
    );
    expect(mentioned.filter((a) => !admitted.has(a!))).toEqual([]);
  });
});

describe("story-to-tests skill: the test plan", () => {
  it("names the plan it may create, when the config scopes one", () => {
    const text = storyToTestsInstructions("1", "Sandbox Plan");
    expect(text).toContain('The plan you may use is named "Sandbox Plan"');
    // the failure this encodes: a fresh project has no plan, list_plans returns
    // [], and the agent listed it three times rather than creating one
    expect(text).toContain("comes back with an empty list: that is not an error");
    expect(text).toContain('name "Sandbox Plan"');
  });

  it("refuses to invent one when no plan is in scope", () => {
    const text = storyToTestsInstructions("1");
    expect(text).toContain("stop and report that no test plan is in scope");
    expect(text).not.toContain("The plan you may use is named");
  });
});

describe("story-to-tests without the Test Plans access level", () => {
  const skill = storyToTestsSkill({ workItem: "1", requireSuiteMembership: false });

  it("does not show the model tools the environment cannot perform", () => {
    expect(skill.allowedTools).not.toContain("ado.testplan");
    expect(skill.allowedTools).not.toContain("ado.testplan_test_plan_write");
    expect(skill.allowedTools).not.toContain("ado.testplan_test_suite_write");
  });

  it("keeps case creation, which is an ordinary work-item write", () => {
    expect(skill.allowedTools).toContain("ado.testplan_test_case_write");
  });

  it("says why the suite step is absent instead of leaving it unexplained", () => {
    expect(skill.instructions).toContain("no Test Plans access level");
    expect(skill.instructions).not.toContain("6. the cases were added to a test suite.");
  });

  it("still tells the agent that an authorization failure is final", () => {
    expect(skill.instructions).toContain("not authorized");
  });
});

describe("the grain of a test case is stated, not left to chance", () => {
  const skill = storyToTestsSkill({ workItem: "1" });

  it("says one case per acceptance criterion, whatever the test count", () => {
    expect(skill.instructions).toContain("ONE CASE PER ACCEPTANCE CRITERION");
    expect(skill.instructions).toContain("Never create a case per test");
  });

  it("allows the scenario count to differ from the case count", () => {
    expect(skill.instructions).toMatch(/[Tt]ests are per behaviour, test cases are per criterion/);
  });
});
