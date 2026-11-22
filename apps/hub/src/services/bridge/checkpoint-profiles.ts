/** Explicit private server configuration; absence never discovers or enables a coordinator. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, normalize, parse, sep } from "node:path";
import { z } from "zod";
import { createLogger } from "../../utils/logger";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";

export const CHECKPOINT_COORDINATOR_FLAG = "PROPOSED_CHECKPOINT_COORDINATOR";
const CONFIG_FILE = "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE";
const CONTROL_PAIR_FLAG = "ENFORCE_CONTROL_PAIR";

/** Checkpoint authority is defined only under control-pair enforcement (`factsMatchProfile`).
 * With the coordinator on and enforcement off, every checkpoint selection would refuse, so the
 * Hub names the missing prerequisite once and loads no profile. Ordinary dispatch is unchanged. */
export function checkpointPrerequisiteError(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env[CHECKPOINT_COORDINATOR_FLAG] !== "true" || env[CONTROL_PAIR_FLAG] === "true") return undefined;
  return `${CHECKPOINT_COORDINATOR_FLAG}=true requires ${CONTROL_PAIR_FLAG}=true; checkpoint profiles are not loaded ` +
    "and checkpoint dispatch stays off. Ordinary dispatch is unaffected.";
}
const envelope = z.object({ version: z.literal("agentpod.checkpoint-profiles.v1"),
  profiles: z.array(z.unknown()).min(1).max(16) }).strict();

function privateOwner(uid: number): boolean { return uid === process.geteuid?.() || uid === 0; }
function readPrivate(path: string): Uint8Array {
  if (!isAbsolute(path) || normalize(path) !== path) throw new CheckpointRefused("invalid");
  let part = parse(path).root;
  for (const name of path.slice(part.length).split(sep)) {
    part = part + (part.endsWith(sep) ? "" : sep) + name;
    if (lstatSync(part).isSymbolicLink()) throw new CheckpointRefused("invalid");
  }
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || !privateOwner(parent.uid)) throw new CheckpointRefused("invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (before.mode & 0o077) !== 0 || !privateOwner(before.uid) || before.size > 65536)
      throw new CheckpointRefused("invalid");
    const out = Buffer.alloc(65537);
    const count = readSync(fd, out, 0, out.length, 0);
    const after = fstatSync(fd);
    if (count > 65536 || count !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size)
      throw new CheckpointRefused("invalid");
    return out.subarray(0, count);
  } finally { closeSync(fd); }
}

/** This reads no file until the exact proposed flag is true. No installed config is supplied by this change. */
export function readCheckpointProfiles(env: Record<string, string | undefined> = process.env): readonly CheckpointProfile[] {
  if (env[CHECKPOINT_COORDINATOR_FLAG] !== "true") return [];
  try {
    const path = env[CONFIG_FILE];
    if (!path) throw new CheckpointRefused("invalid");
    const config = envelope.parse(parseCheckpointJSON(readPrivate(path)));
    const profiles = config.profiles.map(parseCheckpointProfile);
    const names = profiles.map((profile) => [profile.target.tenant_id, profile.target.board_id, profile.target.station_id].join("\0"));
    if (new Set(names).size !== names.length) throw new CheckpointRefused("invalid");
    return Object.freeze(profiles);
  } catch (error) { throw new CheckpointRefused("unavailable", undefined, error); }
}

const log = createLogger("bridge-checkpoint");
let installation: { path: string | undefined; enforced: boolean; profiles: readonly CheckpointProfile[] } | undefined;

/**
 * Stage profiles from the `bench_stages` table (`fleet bench stage`), installed by
 * `installTableCheckpointProfiles` at startup and after every stage write. A process snapshot,
 * like the file: replaced whole, never read row by row on a claim cycle.
 */
let tableProfiles: readonly CheckpointProfile[] = Object.freeze([]);
let merged: { file: readonly CheckpointProfile[]; table: readonly CheckpointProfile[]; profiles: readonly CheckpointProfile[] } | undefined;

/** Replace the table snapshot. The next selection sees it; no restart. */
export function installTableCheckpointProfiles(profiles: readonly CheckpointProfile[]): void {
  tableProfiles = Object.freeze([...profiles]);
}

const sameSelector = (a: CheckpointProfile, b: CheckpointProfile) => a.target.tenant_id === b.target.tenant_id &&
  a.target.board_id === b.target.board_id && a.target.station_id === b.target.station_id;
const sameStage = (a: CheckpointProfile, b: CheckpointProfile) => a.target.tenant_id === b.target.tenant_id &&
  (a.coordinatorProfileId ?? a.profileKey) === (b.coordinatorProfileId ?? b.profileKey);

/**
 * The file's profiles, then the table's: a table row replaces any file profile for the same
 * station and board, or the same stage name in the same workspace. That is how an existing
 * file-based install keeps working unchanged (an empty table shadows nothing) and how `fleet bench
 * stage` takes a stage over from the file without anyone editing it.
 */
export function mergeCheckpointProfiles(file: readonly CheckpointProfile[], table: readonly CheckpointProfile[]): readonly CheckpointProfile[] {
  const kept = file.filter((f) => !table.some((t) => sameSelector(f, t) || sameStage(f, t)));
  return Object.freeze([...kept, ...table]);
}

/** Private pins are installed once per configured path, including a failed load.
 * Editing the same file requires a Hub restart; a stage written with `fleet bench stage` does
 * not. Credentials/current authority are still checked afresh before effects. A malformed file
 * disables only its own profiles, never ordinary agent loops or their legacy client.
 */
export function installedCheckpointProfiles(): readonly CheckpointProfile[] {
  if (process.env[CHECKPOINT_COORDINATOR_FLAG] !== "true") return [];
  const path = process.env[CONFIG_FILE];
  const enforced = process.env[CONTROL_PAIR_FLAG] === "true";
  if (!installation || installation.path !== path || installation.enforced !== enforced)
    installation = { path, enforced, profiles: loadInstallation() };
  // Without control-pair enforcement no profile is served, from the file or the table.
  if (!enforced) return Object.freeze([]);
  if (!merged || merged.file !== installation.profiles || merged.table !== tableProfiles)
    merged = { file: installation.profiles, table: tableProfiles, profiles: mergeCheckpointProfiles(installation.profiles, tableProfiles) };
  return merged.profiles;
}

/** The legacy file's own profiles, as installed: for adopting them into the table. */
export function installedFileCheckpointProfiles(): readonly CheckpointProfile[] {
  if (process.env[CHECKPOINT_COORDINATOR_FLAG] !== "true") return [];
  installedCheckpointProfiles();
  return installation?.profiles ?? [];
}

function loadInstallation(): readonly CheckpointProfile[] {
  const prerequisite = checkpointPrerequisiteError();
  if (prerequisite) {
    // Refuse to load rather than load profiles whose every selection would refuse: one explicit
    // line at installation instead of a refusal per claim cycle. Authority itself is unchanged.
    log.error("checkpoint coordinator prerequisite missing; dedicated dispatch disabled",
      { code: "prerequisite", missing: CONTROL_PAIR_FLAG, detail: prerequisite, reload: "restart-required" });
    return Object.freeze([]);
  }
  // No file is the normal case now: stages come from the table.
  if (!process.env[CONFIG_FILE]) return Object.freeze([]);
  try {
    const profiles = readCheckpointProfiles();
    log.info("checkpoint profile snapshot loaded", { profiles: profiles.length, reload: "restart-required" });
    return profiles;
  } catch (error) {
    // Neither private filenames, profile contents nor raw messages enter logs: a message can quote
    // the path or the file. The error's class and its closed code (an fs errno, a refusal code) do.
    const cause = error instanceof CheckpointRefused ? error.cause : error;
    const errno: unknown = cause instanceof Error ? Reflect.get(cause, "code") : undefined;
    log.warn("checkpoint profile snapshot unavailable; dedicated dispatch disabled for its profiles", { code: "unavailable", reload: "restart-required",
      errorClass: cause instanceof Error ? cause.name : typeof cause, ...(typeof errno === "string" ? { errno } : {}) });
    return Object.freeze([]);
  }
}

/**
 * True only when a successfully loaded installation holds a DIFFERENT profile for the same station:
 * an operator replaced the pins (a node build or pin change). A failed or absent load is never
 * proof, so an unreadable profile file cannot make every live attempt look superseded.
 */
export function checkpointProfileSuperseded(profile: CheckpointProfile): boolean {
  const installed = installedCheckpointProfiles().find((value) => value.target.tenant_id === profile.target.tenant_id &&
    value.target.board_id === profile.target.board_id && value.target.station_id === profile.target.station_id);
  return installed !== undefined && canonicalCheckpoint(installed) !== canonicalCheckpoint(profile);
}

export function requireInstalledCheckpointProfile(profile: CheckpointProfile): void {
  const installed = installedCheckpointProfiles().find((value) => value.target.tenant_id === profile.target.tenant_id &&
    value.target.board_id === profile.target.board_id && value.target.station_id === profile.target.station_id);
  if (!installed || canonicalCheckpoint(installed) !== canonicalCheckpoint(profile)) throw new CheckpointRefused("stale");
}
