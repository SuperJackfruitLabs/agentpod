import { expect, test } from "bun:test";
import { SkillInstallPlan, SkillInstallReceipt } from "./skill-install";

import { planFixture } from "./fixtures/skill-install";

test("durable plans bind identity and a prior head, with activation pending", () => {
  expect(SkillInstallPlan.parse(planFixture).activation).toBe("pending");
  expect(SkillInstallPlan.safeParse({...planFixture, expectedHead: null}).success).toBe(false);
  expect(SkillInstallPlan.safeParse({...planFixture, after: {...planFixture.after, generation: "../outside"}}).success).toBe(false);
  expect(SkillInstallPlan.safeParse({...planFixture, binding: {...planFixture.binding, profile:"../other"}}).success).toBe(false);
  expect(SkillInstallPlan.safeParse({...planFixture, changes:{added:["../outside"],removed:[],changed:[]}}).success).toBe(false);
});
test("durable receipts distinguish interrupted work from completed installation", () => {
  const receipt = {plan:planFixture, phase:"staging", updatedAt:"2026-09-20T16:00:01Z", completedAt:null, error:null};
  expect(SkillInstallReceipt.parse(receipt).completedAt).toBeNull();
  expect(SkillInstallReceipt.safeParse({...receipt, phase:"applied"}).success).toBe(false);
  expect(SkillInstallReceipt.safeParse({...receipt, phase:"applied", completedAt:receipt.updatedAt}).success).toBe(true);
  expect(SkillInstallPlan.safeParse({...planFixture, action:"install", after:null}).success).toBe(false);
  expect(SkillInstallPlan.safeParse({...planFixture, action:"rollback", after:null, targetPath:null}).success).toBe(true);
  expect(SkillInstallPlan.safeParse({...planFixture, targetPath:null}).success).toBe(false);
});
