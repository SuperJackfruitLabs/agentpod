import { expect, test } from "bun:test";
import { SkillPlacementPlan, SkillPlacementReceipt } from "./skill-placement";
import { placementFixture } from "./fixtures/skill-placement";
test("native placement binds a separate head, repository and concrete discovery target", () => {
  expect(SkillPlacementPlan.parse(placementFixture).action).toBe("activate");
  expect(SkillPlacementPlan.safeParse({...placementFixture, expectedInstallationHead:null}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, action:"activate", after:null}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, action:"deactivate", after:null}).success).toBe(true);
  expect(SkillPlacementPlan.safeParse({...placementFixture, action:"deactivate"}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, activation:"loaded"}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, targetPath:null}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, binding:{...placementFixture.binding,harness:"claude-code"}}).success).toBe(false);
  expect(SkillPlacementPlan.parse(placementFixture).nativeLayout).toBe('codex-direct-v1');
  const {nativeLayout: _legacyLayout, ...legacy} = placementFixture;
  expect(SkillPlacementPlan.safeParse({...legacy, discoveryNames:['sjl-fixture:sjl-fixture']}).success).toBe(true);
  expect(SkillPlacementPlan.safeParse({...placementFixture, nativeLayout:'codex-grouped-v1'}).success).toBe(false);
  expect(SkillPlacementPlan.safeParse({...placementFixture, binding:{...placementFixture.binding,harness:'pi'}}).success).toBe(false);
});
test("placement receipt cannot turn interrupted publication into success", () => {
  const receipt={plan:placementFixture,phase:"switching",updatedAt:"2026-09-20T16:00:01Z",completedAt:null,error:null};
  expect(SkillPlacementReceipt.parse(receipt).phase).toBe("switching");
  expect(SkillPlacementReceipt.safeParse({...receipt,phase:"applied"}).success).toBe(false);
  expect(SkillPlacementReceipt.safeParse({...receipt,phase:"applied",completedAt:receipt.updatedAt}).success).toBe(true);
});
