/**
 * The `bench_stages` table and the profile snapshot it installs.
 *
 * Every write here ends by reinstalling the whole snapshot (`installTableCheckpointProfiles`), so
 * a stage written with `fleet bench stage` is selected on the next claim cycle with no restart.
 * A row whose profile no longer parses is skipped and logged, never served half-read.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { benchStages, type BenchStageRow } from "../../db/schema/bench-stages";
import { createLogger } from "../../utils/logger";
import { canonicalCheckpoint } from "./checkpoint-json";
import { parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { installTableCheckpointProfiles } from "./checkpoint-profiles";

const log = createLogger("bench-stages");

export interface StoredStage {
  row: BenchStageRow;
  profile: CheckpointProfile;
}

function parsed(row: BenchStageRow): StoredStage | undefined {
  try {
    return { row, profile: parseCheckpointProfile(JSON.parse(row.profile)) };
  } catch {
    // The name is the operator's own label, safe to log; the profile itself is not logged.
    log.warn("a bench stage's stored profile does not parse; it is not served", { tenantId: row.tenantId, name: row.name });
    return undefined;
  }
}

export async function readStages(tenantId?: string): Promise<StoredStage[]> {
  const rows = await db.select().from(benchStages).where(tenantId ? eq(benchStages.tenantId, tenantId) : undefined);
  return rows.map(parsed).filter((s): s is StoredStage => s !== undefined);
}

export async function readStage(tenantId: string, name: string): Promise<StoredStage | undefined> {
  const [row] = await db.select().from(benchStages).where(and(eq(benchStages.tenantId, tenantId), eq(benchStages.name, name)));
  return row ? parsed(row) : undefined;
}

/** Reload every row into the selection snapshot. Called at startup and after every write. */
export async function reloadStageProfiles(): Promise<number> {
  const stages = await readStages();
  installTableCheckpointProfiles(stages.map((s) => s.profile));
  return stages.length;
}

/** At startup, before the bridge's first claim cycle. Never throws: a failed read serves no table
 * profile, is logged, and is retried by the next stage write. */
export async function installStageProfilesAtStartup(): Promise<void> {
  try {
    const stages = await reloadStageProfiles();
    if (stages > 0) log.info("bench stages installed as checkpoint profiles", { stages });
  } catch (error) {
    log.error("bench stages not installed; no table profile is served", { error: error instanceof Error ? error.message : String(error) });
  }
}

export async function upsertStage(input: {
  tenantId: string; name: string; profile: CheckpointProfile; stageId?: string | null;
  origin: "fleet" | "file"; createdBy?: string | null;
}): Promise<void> {
  const values = {
    tenantId: input.tenantId, name: input.name, boardId: input.profile.target.board_id, stationId: input.profile.target.station_id,
    origin: input.origin, profile: canonicalCheckpoint(input.profile), updatedAt: new Date(),
    ...(input.stageId !== undefined ? { stageId: input.stageId } : {}),
  };
  await db.insert(benchStages).values({ ...values, createdBy: input.createdBy ?? null })
    .onConflictDoUpdate({ target: [benchStages.tenantId, benchStages.name], set: values });
}

export async function deleteStage(tenantId: string, name: string): Promise<boolean> {
  const done = await db.delete(benchStages).where(and(eq(benchStages.tenantId, tenantId), eq(benchStages.name, name)))
    .returning({ name: benchStages.name });
  return done.length > 0;
}

/** One write at a time per process: two stage writes on one node must not interleave. */
let queue: Promise<unknown> = Promise.resolve();
export function serialised<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}
