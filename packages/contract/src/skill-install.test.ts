import { expect, test } from "bun:test";
import { SkillInstallPlan, SkillInstallReceipt, SkillRetentionResult, SkillMaintenanceResult } from "./skill-install";

import { planFixture } from "./fixtures/skill-install";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";
import { Capability } from "./station";

test("skill management requests accept identifiers and reviewed digests, never caller paths or URLs", () => {
  const base = {key:"codex:fixture", profile:"fixture", operationId:"a".repeat(32)};
  const plan = {...base, stationId:"station-fixture", archiveSHA256:"b".repeat(64)};
  expect(VERB_PARAMS["skills.plan"].parse(plan)).toEqual(plan);
  for (const extra of [{workspacePath:"/tmp/other"},{url:"https://example.org/skill.tgz"},{command:"do stuff"}]) {
    expect(VERB_PARAMS["skills.plan"].safeParse({...plan,...extra}).success).toBe(false);
  }
  expect(VERB_PARAMS["skills.apply"].safeParse({...base,stationId:"station-fixture"}).success).toBe(false);
  expect(VERB_PARAMS["skills.apply"].safeParse({...base,stationId:"station-fixture",expectedPlanDigest:"b".repeat(64)}).success).toBe(true);
  expect(VERB_PARAMS["skills.rollback"].parse(base)).toEqual(base);
  expect(VERB_PARAMS["skills.operation"].parse(base)).toEqual(base);
  expect(VERB_PARAMS["skills.verify"].safeParse(base).success).toBe(false);
  expect(Capability.parse("skills.manage")).toBe("skills.manage");
  expect(Capability.parse("skills.native")).toBe("skills.native");
});

test("skill status distinguishes unknown operation and absent managed files from harness activation", () => {
  expect(VERB_RESULTS["skills.operation"].parse({receipt:null})).toEqual({receipt:null});
  const observation = {value:null,observedAt:null,reason:"No session inspection"};
  const status = {nodeId:"fixture-node",stationKey:"codex:fixture",harness:"codex",profile:"fixture",verification:{current:null,path:null,present:{...observation,value:false,observedAt:"2026-09-20T16:00:01Z"},loaded:observation}};
  expect(VERB_RESULTS["skills.verify"].parse(status).verification.loaded.value).toBeNull();
  expect(VERB_RESULTS["skills.verify"].safeParse({...status,verification:{...status.verification,path:"/tmp/claimed"}}).success).toBe(false);
});

test("retention inspection is read-only accounting, including an absent namespace", () => {
  const retention = {nodeId:"fixture-node",stationKey:"codex:fixture",harness:"codex",profile:"fixture",retention:{namespaceExists:false,operations:0,operationLimit:256,generations:0,staging:0,pending:0,nativeOperations:0,nativeStaging:0,nativeBackups:0,observedAt:"2026-09-21T15:00:00Z",limitation:"No managed namespace exists; no state was created"}};
  expect(VERB_PARAMS["skills.retention"].parse({key:"codex:fixture",profile:"fixture"})).toEqual({key:"codex:fixture",profile:"fixture"});
  expect(SkillRetentionResult.parse(retention).retention.namespaceExists).toBe(false);
  expect(SkillRetentionResult.safeParse({...retention,retention:{...retention.retention,operationLimit:255}}).success).toBe(false);
});

test("maintenance preview is a bounded read-only plan", () => {
  const result = {nodeId:"fixture-node",stationKey:"codex:fixture",harness:"codex",profile:"fixture",maintenance:{preview:{generations:["a".repeat(32)],operations:[],nativeOperations:[],nativeBackups:[]},planDigest:"b".repeat(64),observedAt:"2026-09-21T15:00:00Z",limitation:"Read-only preview"}};
  expect(VERB_PARAMS["skills.maintenance.plan"].parse({key:"codex:fixture",profile:"fixture"})).toEqual({key:"codex:fixture",profile:"fixture"});
  expect(VERB_PARAMS["skills.maintenance.plan"].safeParse({key:"codex:fixture",profile:"fixture",operationId:"a".repeat(32)}).success).toBe(false);
  expect(SkillMaintenanceResult.parse(result).maintenance.preview.generations).toHaveLength(1);
});

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
