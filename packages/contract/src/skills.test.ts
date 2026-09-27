import { test, expect } from "bun:test";
import { SkillInventory, SkillObservation, SkillEntry } from "./skills";
import { Capability, CapabilityList } from "./station";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";

import { skillFixture, inventoryFixture } from "./fixtures/skill-inventory";
const { present, eligible: unknown } = skillFixture.evidence;

test("presence does not turn unknown eligibility, loading or exercise into false or true", () => {
  const s = SkillInventory.parse(inventoryFixture).skills[0]!;
  expect(s.evidence.present.value).toBe(true);
  for (const state of [
    "catalogued",
    "eligible",
    "loaded",
    "exercised",
  ] as const) {
    expect(s.evidence[state].value).toBeNull();
    expect(s.evidence[state].observedAt).toBeNull();
  }
  expect(s.source.artifactDigest).toBeNull();
  expect(s.entrypointDigest).toBe("a".repeat(64));
  expect(s.effectivePath).toBeNull();
});

test("observations cannot claim knowledge without a timestamp and reason", () => {
  expect(
    SkillObservation.safeParse({ ...present, observedAt: null }).success,
  ).toBe(false);
  expect(SkillObservation.safeParse({ ...unknown, reason: "" }).success).toBe(
    false,
  );
  expect(
    SkillObservation.safeParse({ ...present, observedAt: "yesterday" }).success,
  ).toBe(false);
});

test("partial inventory remains partial and each evidence dimension is required", () => {
  expect(SkillInventory.parse(inventoryFixture).coverage.complete).toBe(false);
  const { loaded, ...incomplete } = skillFixture.evidence;
  expect(
    SkillEntry.safeParse({ ...skillFixture, evidence: incomplete }).success,
  ).toBe(false);
  expect(
    SkillInventory.safeParse({ ...inventoryFixture, coverage: undefined })
      .success,
  ).toBe(false);
});

test("shadowed entries identify their winner; unknown precedence invents no winner", () => {
  expect(
    SkillEntry.safeParse({
      ...skillFixture,
      shadowing: { status: "shadowed", by: null, candidates: [] },
    }).success,
  ).toBe(false);
  expect(
    SkillEntry.safeParse({
      ...skillFixture,
      shadowing: { status: "unknown", by: "/guessed", candidates: [] },
    }).success,
  ).toBe(false);
});

test("inventory accepts only a station key, never a caller's scan root or command", () => {
  const schema = VERB_PARAMS["skills.inventory"];
  expect(schema.parse({ key: "hermes:writer" })).toEqual({
    key: "hermes:writer",
  });
  for (const bad of [
    {},
    { key: "" },
    { key: "hermes:writer", path: "/home/other" },
    { key: "hermes", command: "cat credentials" },
  ]) {
    expect(schema.safeParse(bad).success).toBe(false);
  }
  expect(
    VERB_RESULTS["skills.inventory"].parse(inventoryFixture).plugins,
  ).toEqual([]);
});

test("inventory is optional and grants no management capability", () => {
  expect(Capability.parse("skills.inventory")).toBe("skills.inventory");
  expect(
    CapabilityList.parse(["health", "future.verb", "skills.inventory"]),
  ).toEqual(["health", "skills.inventory"]);
  expect(CapabilityList.parse(["health"])).toEqual(["health"]);
});
