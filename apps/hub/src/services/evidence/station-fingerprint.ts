/**
 * What a station is running, resolved from rows this hub already holds.
 *
 * Charter decision 3: "an attempt on a station that cannot answer opens with an unknown
 * fingerprint rather than waiting." So nothing here asks the node, nothing here throws, and the
 * caller bounds it with `fingerprintWithin`.
 *
 * Today's sources, and their limits (superwitness contract C3):
 *   - harness, profile: the station row. Profile is the `hermes:<name>` suffix, `default` for a
 *     harness's root station, the key itself otherwise.
 *   - skill_release: the latest APPLIED managed operation per skill profile, joined to the trusted
 *     release that pins its artifact. A rollback or an unpinned artifact makes it "unknown".
 *   - harness_version, model: "unknown", reported_by "hub". No harness reports either to the hub;
 *     the node probes versions for skill gating but never sends them, and ACP carries no model.
 */
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { tenantScope } from "../../db/tenant-scope";
import { createLogger } from "../../utils/logger";
import { makeFingerprint, UNKNOWN, type Fingerprint } from "./fingerprint";

const log = createLogger("fingerprint");

export const FINGERPRINT_TIMEOUT_MS = 2_000;

export function profileFromStationKey(harness: string, stationKey: string): string {
  if (stationKey === harness) return "default";
  const prefix = `${harness}:`;
  if (stationKey.startsWith(prefix) && stationKey.length > prefix.length) return stationKey.slice(prefix.length);
  return stationKey;
}

export async function appliedSkillRelease(tenantId: string, stationId: string): Promise<string> {
  const rows = await rawSql<
    { profile: string; action: string; release_version: string | null; release_profile: string | null; record_digest: string | null }[]
  >`
    SELECT DISTINCT ON (so.profile)
           so.profile, so.action,
           tsr.version AS release_version, tsr.profile AS release_profile, tsr.record_digest
      FROM skill_operations so
      LEFT JOIN trusted_skill_release_artifacts tra
             ON tra.artifact_id = so.artifact_id AND tra.tenant_id = so.tenant_id AND tra.user_id = so.user_id
      LEFT JOIN trusted_skill_releases tsr
             ON tsr.id = tra.release_id AND tsr.tenant_id = tra.tenant_id AND tsr.user_id = tra.user_id
     WHERE so.tenant_id = ${tenantId} AND so.station_id = ${stationId}
       AND so.kind = 'managed' AND so.state = 'applied'
     ORDER BY so.profile, so.updated_at DESC, so.created_at DESC`;

  if (rows.length === 0) return "none";
  const parts: string[] = [];
  for (const r of rows) {
    // A rollback restores an earlier state this table does not name; an unpinned artifact is not
    // a release. Either way the station's skill configuration is not known, and saying so beats
    // naming the release it used to have.
    if (r.action !== "install" || !r.record_digest || !r.release_version) return UNKNOWN;
    parts.push(`${r.release_profile ?? r.profile}@${r.release_version}:sha256:${r.record_digest}`);
  }
  return parts.sort().join(",");
}

export async function resolveStationFingerprint(tenantId: string, stationId: string): Promise<Fingerprint> {
  try {
    const [station] = await db
      .select({ harness: stations.harness, stationKey: stations.stationKey })
      .from(stations)
      .where(tenantScope(stations, tenantId, eq(stations.id, stationId)))
      .limit(1);
    if (!station) return makeFingerprint({}, "hub");
    return makeFingerprint(
      {
        harness: station.harness,
        profile: profileFromStationKey(station.harness, station.stationKey),
        harness_version: UNKNOWN,
        model: UNKNOWN,
        skill_release: await appliedSkillRelease(tenantId, stationId),
      },
      "hub",
    );
  } catch (err) {
    log.warn("fingerprint unresolved; recording unknown", { stationId, error: String(err) });
    return makeFingerprint({}, "hub");
  }
}

/** Bound any resolver: a late or failed answer becomes the all-unknown fingerprint. */
export async function fingerprintWithin(
  resolve: () => Promise<Fingerprint>,
  timeoutMs: number = FINGERPRINT_TIMEOUT_MS,
): Promise<Fingerprint> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Fingerprint>((done) => {
    timer = setTimeout(() => done(makeFingerprint({}, "hub")), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(resolve).catch(() => makeFingerprint({}, "hub")), late]);
  } finally {
    clearTimeout(timer);
  }
}
