import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCheckpointProfiles, CHECKPOINT_COORDINATOR_FLAG } from "./checkpoint-profiles";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const fixtureRequest = corpus.requests.find((item) => item.name === "prepare");
  if (!fixtureRequest) throw new Error("fixture prepare missing");
  const request = fixtureRequest.value;
  if (!("target" in request)) throw new Error("fixture target missing");
  return { version: "agentpod.checkpoint-profile.v1", organizationId: "org_" + "a".repeat(20),
    sourceTenantId: "tnt_source", sourceOrigin: "https://pipeline.test", sourceAudience: "https://app.superpipeline.dev",
    reporterPrincipalId: "prn_" + "b".repeat(20), ownerPrincipalId: "prn_" + "c".repeat(20),
    occupantPrincipalId: "prn_" + "d".repeat(20), agentKey: "fixture", profileKey: "fixture", occupancyEpoch: 1,
    target: request.target, checkpointRepository: "api",
    repositories: [{ name: "api", provider: "forge", repository: "example/api", repositorySHA256: "e".repeat(64), objectFormat: "sha1" }] };
}
function installed() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "checkpoint-profile-"))); roots.push(root); chmodSync(root, 0o700);
  const file = join(root, "profiles.json");
  writeFileSync(file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [fixture()] }), { mode: 0o600 });
  return { root, file, env: { [CHECKPOINT_COORDINATOR_FLAG]: "true", PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE: file } };
}
test("no opt-in never reads even an invalid configured path", () => {
  expect(readCheckpointProfiles({ PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE: "/unavailable" })).toEqual([]);
  expect(readCheckpointProfiles({ [CHECKPOINT_COORDINATOR_FLAG]: "1" })).toEqual([]);
});
test("private physical installation returns immutable exact pins", () => {
  const f = installed(); const profiles = readCheckpointProfiles(f.env);
  expect(profiles).toHaveLength(1);
  expect(profiles[0]?.sourceTenantId).toBe("tnt_source");
  expect(Object.isFrozen(profiles[0]?.target)).toBe(true);
  expect(Object.isFrozen(profiles[0]?.repositories)).toBe(true);
});
test("readable config, parent, symlink, unknown key and duplicate selector refuse", () => {
  const f = installed(); chmodSync(f.file, 0o644); expect(() => readCheckpointProfiles(f.env)).toThrow(); chmodSync(f.file, 0o600);
  chmodSync(f.root, 0o755); expect(() => readCheckpointProfiles(f.env)).toThrow(); chmodSync(f.root, 0o700);
  const link = join(f.root, "alias"); symlinkSync(f.file, link);
  expect(() => readCheckpointProfiles({ ...f.env, PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE: link })).toThrow();
  writeFileSync(f.file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [fixture()], token: "not-a-credential" }));
  expect(() => readCheckpointProfiles(f.env)).toThrow();
  writeFileSync(f.file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [fixture(), fixture()] }));
  expect(() => readCheckpointProfiles(f.env)).toThrow();
});
