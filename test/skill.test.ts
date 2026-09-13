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
