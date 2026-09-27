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
test("placement admits every harness the node places for, each pinned to its own layout", () => {
  // The node places natively for six harnesses; this schema is what the hub
  // validates their plans against. Hermes and Claude were added to the node
  // and never here, so a correct Hermes plan was rejected as "invalid node
  // plan" with nothing naming the field -- found by a live canary, not a test.
  const withHarness = (harness: string, nativeLayout?: string) => ({
    ...placementFixture,
    binding: {...placementFixture.binding, harness, stationKey: harness + ":fixture"},
    ...(nativeLayout === undefined ? {} : {nativeLayout}),
  });
  const {nativeLayout: _drop, ...noLayout} = placementFixture;
  const bare = (harness: string) => ({
    ...noLayout,
    binding: {...placementFixture.binding, harness, stationKey: harness + ":fixture"},
  });

  // Every harness the node can place for parses.
  for (const harness of ["codex", "opencode", "pi", "openclaw", "claude-code", "hermes"]) {
    expect(SkillPlacementPlan.safeParse(bare(harness)).success).toBe(true);
  }

  // A direct layout is admitted only for the harness that owns it, so a plan
  // cannot claim another harness's projection.
  expect(SkillPlacementPlan.safeParse(withHarness("claude-code", "claude-direct-v1")).success).toBe(true);
  expect(SkillPlacementPlan.safeParse(withHarness("hermes", "hermes-direct-v1")).success).toBe(true);
  expect(SkillPlacementPlan.safeParse(withHarness("codex", "codex-direct-v1")).success).toBe(true);
  for (const [harness, layout] of [
    ["claude-code", "codex-direct-v1"], ["hermes", "codex-direct-v1"],
    ["codex", "hermes-direct-v1"], ["pi", "claude-direct-v1"],
    ["opencode", "codex-direct-v1"], ["openclaw", "hermes-direct-v1"],
  ]) {
    expect(SkillPlacementPlan.safeParse(withHarness(harness, layout)).success).toBe(false);
  }
  expect(SkillPlacementPlan.safeParse(withHarness("hermes", "hermes-grouped-v1")).success).toBe(false);
  expect(SkillPlacementPlan.safeParse(withHarness("nonesuch", undefined)).success).toBe(false);
});
test("placement receipt cannot turn interrupted publication into success", () => {
  const receipt={plan:placementFixture,phase:"switching",updatedAt:"2026-09-20T16:00:01Z",completedAt:null,error:null};
  expect(SkillPlacementReceipt.parse(receipt).phase).toBe("switching");
  expect(SkillPlacementReceipt.safeParse({...receipt,phase:"applied"}).success).toBe(false);
  expect(SkillPlacementReceipt.safeParse({...receipt,phase:"applied",completedAt:receipt.updatedAt}).success).toBe(true);
});
