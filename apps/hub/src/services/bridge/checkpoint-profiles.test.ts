import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { installTableCheckpointProfiles, installedCheckpointProfiles, mergeCheckpointProfiles, readCheckpointProfiles,
  requireInstalledCheckpointProfile, CHECKPOINT_COORDINATOR_FLAG } from "./checkpoint-profiles";
import corpus from "../../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";

import { checkpointProfileId, checkpointTask, claimRepositoriesAllowed, parseCheckpointProfile } from "./checkpoint-profile";
import { canonicalCheckpoint } from "./checkpoint-json";
import { checkpointRuntime } from "./checkpoint-port";
const prior = { flag: process.env.PROPOSED_CHECKPOINT_COORDINATOR, file: process.env.PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE, pair: process.env.ENFORCE_CONTROL_PAIR };
const roots: string[] = [];
afterEach(() => {
  for (const [key, value] of Object.entries({ PROPOSED_CHECKPOINT_COORDINATOR: prior.flag, PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE: prior.file, ENFORCE_CONTROL_PAIR: prior.pair })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const fixtureRequest = corpus.requests.find((item) => item.name === "prepare");
  if (!fixtureRequest) throw new Error("fixture prepare missing");
  const request = fixtureRequest.value;
  if (!("target" in request) || !request.target) throw new Error("fixture target missing");
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
  return { root, file, env: { [CHECKPOINT_COORDINATOR_FLAG]: "true", PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE: file, ENFORCE_CONTROL_PAIR: "true" } };
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

test("an enabled unavailable installation does not fail an unrelated ordinary agent", () => {
  const f = installed(); Object.assign(process.env, f.env); unlinkSync(f.file);
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(checkpointRuntime("ordinary-tenant", "ordinary-board", "ordinary-station", "ordinary-agent")).toBeUndefined();
    // A repaired file is not silently reread on a later cycle; explicit restart/reconfiguration is required.
    writeFileSync(f.file, JSON.stringify({ version: "agentpod.checkpoint-profiles.v1", profiles: [fixture()] }), { mode: 0o600 });
    const p = fixture(); const t = p.target;
    expect(checkpointRuntime(t.tenant_id, t.board_id, t.station_id, p.agentKey)).toBeUndefined();
    expect(warning).toHaveBeenCalledTimes(1);
    const message = JSON.stringify(warning.mock.calls);
    expect(message).toContain("dedicated dispatch disabled");
    expect(message).not.toContain(f.file);
    expect(message).not.toContain(p.sourceOrigin);
  } finally { warning.mockRestore(); }
});
test("installed pins are a stable snapshot rather than a filesystem read every cycle", () => {
  const f = installed(); Object.assign(process.env, f.env); const profile = fixture(); const t = profile.target;
  const runtime = () => checkpointRuntime(t.tenant_id, t.board_id, t.station_id, profile.agentKey);
  expect(runtime()).toBeDefined(); const [pin] = readCheckpointProfiles(f.env); unlinkSync(f.file);
  expect(runtime()).toBeDefined();
  if (!pin) throw new Error("fixture pin missing");
  expect(() => requireInstalledCheckpointProfile(pin)).not.toThrow();
  delete process.env.PROPOSED_CHECKPOINT_COORDINATOR;
  expect(runtime()).toBeUndefined();
  expect(() => requireInstalledCheckpointProfile(pin)).toThrow(/Checkpoint/);
  const installedProfile = readCheckpointProfiles({});
  expect(installedProfile).toEqual([]); // Explicit flag-off remains free of config reads.
});

test("a non-regular profile cannot block the bridge while opening its snapshot", () => {
  const f = installed(); unlinkSync(f.file);
  const fifo = spawnSync("mkfifo", [f.file]);
  expect(fifo.status).toBe(0); chmodSync(f.file, 0o600);
  const script = `import {readCheckpointProfiles} from ${JSON.stringify(join(import.meta.dir, "checkpoint-profiles.ts"))};
    try { readCheckpointProfiles(${JSON.stringify(f.env)}); process.exit(2); } catch { process.exit(0); }`;
  const child = spawnSync(process.execPath, ["--eval", script], { timeout: 2000, stdio: "pipe" });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
});


test("coordinator profile identity is independent of the default harness profile", () => {
  const named = fixture();
  const legacy = parseCheckpointProfile(named);
  expect(checkpointProfileId(legacy)).toBe(named.profileKey);
  expect(canonicalCheckpoint(legacy)).toBe(canonicalCheckpoint(named));
  expect(Object.hasOwn(legacy, "coordinatorProfileId")).toBe(false);
  const selected = parseCheckpointProfile({ ...named, profileKey: "", coordinatorProfileId: "fixture-profile" });
  expect(selected.profileKey).toBe("");
  expect(checkpointProfileId(selected)).toBe("fixture-profile");
  const independent = parseCheckpointProfile({ ...named, coordinatorProfileId: "other-coordinator" });
  expect(independent.profileKey).toBe(named.profileKey);
  expect(checkpointProfileId(independent)).toBe("other-coordinator");
});
test("a default harness profile requires a valid explicit coordinator identity", () => {
  expect(() => parseCheckpointProfile({ ...fixture(), profileKey: "" })).toThrow("Checkpoint refused: invalid");
  expect(() => parseCheckpointProfile({ ...fixture(), profileKey: null, coordinatorProfileId: "fixture-profile" })).toThrow("Checkpoint refused: invalid");
  for (const coordinatorProfileId of ["", " invalid", "bad\n", null]) {
    expect(() => parseCheckpointProfile({ ...fixture(), profileKey: "", coordinatorProfileId })).toThrow("Checkpoint refused: invalid");
  }
});

test("the bench task names the checkpoint repository, so the harness never starts in the workspace root", () => {
  const single = parseCheckpointProfile(fixture());
  expect(checkpointTask(single, "do the card")).toEqual({ profile_id: "fixture", prompt: "do the card", timeout_seconds: 1800,
    repository_name: "api" });
  const repositories = [
    { name: "api", provider: "forge", repository: "example/api", repositorySHA256: "e".repeat(64), objectFormat: "sha1" },
    { name: "web", provider: "forge", repository: "example/web", repositorySHA256: "f".repeat(64), objectFormat: "sha1" }];
  expect(checkpointTask(parseCheckpointProfile({ ...fixture(), repositories, checkpointRepository: "web" }), "x").repository_name).toBe("web");
  // A multi-repository profile with no checkpoint repository, or one that is not a member, is refused at load.
  const { checkpointRepository: _omitted, ...missing } = { ...fixture(), repositories };
  expect(() => parseCheckpointProfile(missing)).toThrow();
  expect(() => parseCheckpointProfile({ ...fixture(), repositories, checkpointRepository: "docs" })).toThrow();
});

test("an empty stage table changes nothing: the file's profiles are served as installed", () => {
  const f = installed(); Object.assign(process.env, f.env);
  installTableCheckpointProfiles([]);
  const [pin] = readCheckpointProfiles(f.env);
  if (!pin) throw new Error("fixture pin missing");
  expect(installedCheckpointProfiles()).toEqual([pin]);
});

test("a stage row replaces the file's profile for the same station and board, or the same stage name", () => {
  const file = parseCheckpointProfile(fixture());
  const other = parseCheckpointProfile({ ...fixture(), profileKey: "other", target: { ...fixture().target, board_id: "brd_other0001" } });
  const sameSelector = parseCheckpointProfile({ ...fixture(), profileKey: "renamed", target: { ...fixture().target, registry_sha256: "f".repeat(64) } });
  const sameName = parseCheckpointProfile({ ...fixture(), target: { ...fixture().target, board_id: "brd_moved0001" } });
  expect(mergeCheckpointProfiles([file, other], [])).toEqual([file, other]);
  expect(mergeCheckpointProfiles([file, other], [sameSelector])).toEqual([other, sameSelector]);
  expect(mergeCheckpointProfiles([file, other], [sameName])).toEqual([other, sameName]);
  // Another workspace's stage of the same name shadows nothing here.
  const foreign = parseCheckpointProfile({ ...fixture(), target: { ...fixture().target, tenant_id: "fleet_elsewhere", board_id: "brd_moved0001" } });
  expect(mergeCheckpointProfiles([file], [foreign])).toEqual([file, foreign]);
});

test("a table profile is selected with no restart, and replacing the table drops it", () => {
  const f = installed(); Object.assign(process.env, f.env);
  const moved = parseCheckpointProfile({ ...fixture(), target: { ...fixture().target, board_id: "brd_moved0001" } });
  const t = moved.target;
  try {
    expect(checkpointRuntime(t.tenant_id, t.board_id, t.station_id, moved.agentKey)).toBeUndefined();
    installTableCheckpointProfiles([moved]);
    expect(checkpointRuntime(t.tenant_id, t.board_id, t.station_id, moved.agentKey)).toBeDefined();
    // The file's copy of the same stage is no longer served next to it.
    const file = fixture().target;
    expect(checkpointRuntime(file.tenant_id, file.board_id, file.station_id, moved.agentKey)).toBeUndefined();
  } finally { installTableCheckpointProfiles([]); }
  expect(checkpointRuntime(t.tenant_id, t.board_id, t.station_id, moved.agentKey)).toBeUndefined();
});

test("without the control pair no table profile is served either", () => {
  const f = installed(); Object.assign(process.env, f.env);
  delete process.env.ENFORCE_CONTROL_PAIR;
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    installTableCheckpointProfiles([parseCheckpointProfile(fixture())]);
    expect(installedCheckpointProfiles()).toEqual([]);
  } finally { installTableCheckpointProfiles([]); error.mockRestore(); }
});

test("a claim names exactly the stage's allow-list today", () => {
  const api = { name: "api", provider: "forge", repository: "example/api" };
  const web = { name: "web", provider: "forge", repository: "example/web" };
  expect(claimRepositoriesAllowed([api, web], [api, web])).toBe(true);
  expect(claimRepositoriesAllowed([api, web], [api])).toBe(false);
  expect(claimRepositoriesAllowed([api, web], [web, api])).toBe(false);
  expect(claimRepositoriesAllowed([api, web], [api, { ...web, repository: "example/other" }])).toBe(false);
});
