/**
 * One agent principal per adopted station — the one-time backfill for a fleet
 * that predates principals. Idempotent: a station that already has one is left
 * alone, so this is safe to re-run after adopting more stations.
 *
 * After this, creating an agent is a deliberate act and station adoption LINKS
 * to an existing principal rather than implying one.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { closeDatabase, db } from "../src/db/drizzle";
import { nodes } from "../src/db/schema/nodes";
import { BOOTSTRAP_ORG_ID, principals } from "../src/db/schema/organization";
import { stations } from "../src/db/schema/stations";
import { createPrincipal } from "../src/services/principals";
import { createLogger } from "../src/utils/logger";

const log = createLogger("seed-agent-principals");

/** `guild` + `hermes:writer-quill` → `writer-quill`; falls back to the whole key. */
const handleFor = (stationKey: string): string => {
  const tail = stationKey.includes(":") ? stationKey.slice(stationKey.indexOf(":") + 1) : stationKey;
  return tail.toLowerCase().replace(/[^a-z0-9._=/-]/g, "-");
};

/** The id of an existing principal on this handle, if one was already minted. */
async function findByHandle(handle: string): Promise<string | null> {
  const [row] = await db
    .select({ id: principals.id })
    .from(principals)
    .where(and(eq(principals.orgId, BOOTSTRAP_ORG_ID), eq(principals.handle, handle)));
  return row?.id ?? null;
}

/** Whether some OTHER station already occupies this principal. */
async function claimedByAnotherStation(principalId: string, stationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: stations.id })
    .from(stations)
    .where(eq(stations.principalId, principalId));
  return row !== undefined && row.id !== stationId;
}

export async function seedAgentPrincipals(): Promise<{ created: number; skipped: number }> {
  const [totalRow] = await db.select({ count: sql<number>`count(*)::int` }).from(stations);
  const totalStations = totalRow?.count ?? 0;

  const rows = await db
    .select({ id: stations.id, key: stations.stationKey, node: nodes.name })
    .from(stations)
    .innerJoin(nodes, eq(nodes.id, stations.nodeId))
    .where(isNull(stations.principalId));

  // Stations that already had a principal before this run started — the ones
  // this run has nothing to do for. Computed up front so a second run, which
  // seeds nothing, still reports a real number instead of silence.
  const skipped = totalStations - rows.length;

  let created = 0;
  for (const s of rows) {
    // Two nodes can carry the same station key — `opencode:c52ddf65` did — so
    // the handle is qualified when the bare one is taken by a DIFFERENT
    // station. When it was minted for THIS station on an earlier, partial
    // run — createPrincipal succeeded but the update to link it crashed
    // before landing — the bare handle is still this station's own, and
    // re-running must link it rather than mint a second, orphaned principal.
    let handle = handleFor(s.key);
    let principalId = await findByHandle(handle);
    if (principalId && (await claimedByAnotherStation(principalId, s.id))) {
      handle = `${s.node}-${handle}`;
      principalId = await findByHandle(handle);
    }
    if (!principalId) {
      principalId = await createPrincipal({ kind: "agent", handle, displayName: s.key });
    }

    await db.update(stations).set({ principalId }).where(eq(stations.id, s.id));
    created++;
  }
  return { created, skipped };
}

// ─── Entry point — everything below runs only when this file is executed  ───
// ─── directly (`bun run scripts/seed-agent-principals.ts`), not under      ───
// ─── `bun test`, which imports `seedAgentPrincipals` on its own.           ───

async function main(): Promise<void> {
  try {
    const { created, skipped } = await seedAgentPrincipals();
    // A seed that prints nothing is indistinguishable from a seed that did
    // nothing — which is exactly the defect this entry point exists to close.
    console.log(`seeded ${created} station(s) with a new agent principal, skipped ${skipped} (already had one)`);
  } finally {
    // Without this the pool's idle connection holds the process open until
    // its own timeout, so a script that already finished still doesn't
    // return control to the operator (or a test) for up to twenty seconds.
    await closeDatabase();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    log.error("seed run crashed", { error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  });
}
