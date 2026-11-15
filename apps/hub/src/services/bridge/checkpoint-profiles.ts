/** Explicit private server configuration; absence never discovers or enables a coordinator. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, normalize, parse, sep } from "node:path";
import { z } from "zod";
import { canonicalCheckpoint, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";

export const CHECKPOINT_COORDINATOR_FLAG = "PROPOSED_CHECKPOINT_COORDINATOR";
const CONFIG_FILE = "PROPOSED_CHECKPOINT_COORDINATOR_PROFILE_FILE";
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
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  } catch { throw new CheckpointRefused("unavailable"); }
}

export function requireInstalledCheckpointProfile(profile: CheckpointProfile): void {
  const installed = readCheckpointProfiles().find((value) => value.target.tenant_id === profile.target.tenant_id &&
    value.target.board_id === profile.target.board_id && value.target.station_id === profile.target.station_id);
  if (!installed || canonicalCheckpoint(installed) !== canonicalCheckpoint(profile)) throw new CheckpointRefused("stale");
}
