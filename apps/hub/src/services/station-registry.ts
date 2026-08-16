/**
 * Station Registry — persist / query adopted stations.
 *
 * "Adopting" a station is the act of saving a detected remote station to the
 * local DB so the fleet console can track it across reconnects.
 *
 * All functions are scoped to (userId, ...) so callers can never access another
 * user's data by providing a different nodeId or stationId.
 */

import { and, eq, sql } from "drizzle-orm";
import { notifyStationsAdopted } from "./matrix-as/hooks";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { tenantScope } from "../db/tenant-scope";
import { resolveTenantForUser } from "../auth/tenant";
import { VERB_RESULTS } from "@agentpod/contract";
import type { DetectedStation } from "@agentpod/contract";
import * as broker from "./broker";

export type StationRow = typeof stations.$inferSelect;

// ─── adoptStations ────────────────────────────────────────────────────────────

/**
 * Upsert the requested station keys from a freshly detected list.
 *
 * Algorithm
 * ─────────
 * 1. Filter detected[] to the requested keys.
 * 2. First pass: upsert all rows with parentStationId = null.
 *    The ON CONFLICT target is the unique (nodeId, stationKey) index, so this
 *    is idempotent — re-adopting a station refreshes its metadata.
 * 3. Second pass: resolve each parentKey → parentStationId by looking up
 *    all rows already persisted for this (userId, nodeId).  This covers the
 *    case where a parent was adopted in a previous call.
 * 4. Return the final rows for the requested keys.
 */
export async function adoptStations(
  userId: string,
  nodeId: string,
  keys: string[],
  detected: DetectedStation[]
): Promise<StationRow[]> {
  const toAdopt = detected.filter((d) => keys.includes(d.key));
  if (toAdopt.length === 0) return [];

  // A station's tenant is its node's, read from the node rather than resolved
  // from the caller. The composite FK (stations.node_id, tenant_id) → nodes
  // makes the alternative unrepresentable anyway: a request cannot adopt a
  // station into a tenant its node is not in, so asking the node is the only
  // answer that can succeed.
  const [nodeRow] = await db
    .select({ tenantId: nodes.tenantId })
    .from(nodes)
    .where(eq(nodes.id, nodeId));
  if (!nodeRow) throw new Error(`cannot adopt stations on unknown node ${nodeId}`);
  const tenantId = nodeRow.tenantId;

  // ── First pass: upsert all rows without parent links ─────────────────────
  for (const station of toAdopt) {
    await db
      .insert(stations)
      .values({
        id: `station_${crypto.randomUUID()}`,
        tenantId,
        userId,
        nodeId,
        harness: station.harness,
        stationKey: station.key,
        kind: station.kind,
        displayName: station.displayName,
        workspacePath: station.workspacePath ?? null,
        capabilities: station.capabilities as string[],
        matrixId: station.matrixId ?? null,
        parentStationId: null,
        adoptedAt: new Date(),
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [stations.nodeId, stations.stationKey],
        set: {
          harness: station.harness,
          kind: station.kind,
          displayName: station.displayName,
          workspacePath: station.workspacePath ?? null,
          capabilities: station.capabilities as string[],
          matrixId: station.matrixId ?? null,
          adoptedAt: new Date(),
        },
      });
  }

  // ── Second pass: resolve parent links ─────────────────────────────────────
  // Load ALL adopted rows for this node (including those from prior calls)
  // so that a parent adopted in an earlier request is also resolved.
  const allRows = await db
    .select({ id: stations.id, stationKey: stations.stationKey })
    .from(stations)
    .where(and(eq(stations.userId, userId), eq(stations.nodeId, nodeId)));

  const keyToId = new Map(allRows.map((r) => [r.stationKey, r.id]));

  for (const station of toAdopt) {
    if (!station.parentKey) continue;
    const parentId = keyToId.get(station.parentKey);
    if (!parentId) continue;
    const ownId = keyToId.get(station.key);
    if (!ownId) continue;
    await db
      .update(stations)
      .set({ parentStationId: parentId })
      .where(eq(stations.id, ownId));
  }

  // ── Return the final rows for the requested keys ──────────────────────────
  const allAdopted = await db
    .select()
    .from(stations)
    .where(and(eq(stations.userId, userId), eq(stations.nodeId, nodeId)));

  const adopted = allAdopted.filter((r) => keys.includes(r.stationKey));

  // Announce, do not act: this module knows nothing about Matrix, and nobody
  // listens when the bridge is off. Fire-and-forget, because adoption has
  // already succeeded and a bridge that could not make a room must not make it
  // look as though the station was not adopted.
  notifyStationsAdopted(adopted.map((r) => r.id));

  return adopted;
}

// ─── listAdopted ─────────────────────────────────────────────────────────────

/** All adopted stations for a specific (user, node) pair. */
export async function listAdopted(
  userId: string,
  nodeId: string
): Promise<StationRow[]> {
  const tenantId = await resolveTenantForUser(userId);
  return db
    .select()
    .from(stations)
    .where(
      tenantScope(stations, tenantId, eq(stations.userId, userId), eq(stations.nodeId, nodeId)),
    );
}

// ─── getStation ───────────────────────────────────────────────────────────────

/** Single station by id, scoped to the user. Returns null if not found or not owned. */
export async function getStation(
  userId: string,
  stationId: string
): Promise<StationRow | null> {
  const rows = await db
    .select()
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)));
  return rows[0] ?? null;
}

// ─── unadopt ─────────────────────────────────────────────────────────────────

/** Remove a station row. Silently succeeds if already gone or not owned. */
export async function unadopt(
  userId: string,
  stationId: string
): Promise<void> {
  await db
    .delete(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)));
}

// ─── refreshAdoptedCapabilities ───────────────────────────────────────────────

/** Injectable deps — mirrors AutoAdoptDeps so tests avoid a live WebSocket. */
export interface RefreshCapsDeps {
  brokerRequest?: (
    nodeId: string,
    verb: string,
    params: unknown,
    opts?: { timeoutMs?: number }
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

/**
 * Re-read a node's capabilities into the stations already adopted from it.
 *
 * adoptStations was the ONLY writer of `stations.capabilities`, so a station
 * adopted before a capability existed could never gain it: the node reported it
 * on every detect and the hub kept serving the row it stored at adoption. Any
 * new capability hits this, which is why the fix lives here rather than in the
 * feature that found it.
 *
 * Updates existing (nodeId, stationKey) rows ONLY. It must never insert:
 * adoption is an explicit act, and an auto-inserting refresh would quietly
 * adopt everything a node can see.
 *
 * Returns the number of rows updated. Never throws — it runs on node connect.
 */
export async function refreshAdoptedCapabilities(
  nodeId: string,
  deps: RefreshCapsDeps = {}
): Promise<number> {
  try {
    const brokerRequest = deps.brokerRequest ?? broker.request;

    const r = await brokerRequest(nodeId, "detect", {}, { timeoutMs: 10_000 });
    if (!r.ok) return 0;

    const parsed = VERB_RESULTS.detect.safeParse(r.data);
    if (!parsed.success) return 0;

    // Only rows that already exist for this node are eligible.
    const existing = await db
      .select({ stationKey: stations.stationKey })
      .from(stations)
      .where(eq(stations.nodeId, nodeId));
    const adopted = new Set(existing.map((row) => row.stationKey));
    if (adopted.size === 0) return 0;

    let updated = 0;
    for (const s of parsed.data) {
      if (!adopted.has(s.key)) continue; // never insert
      await db
        .update(stations)
        .set({
          capabilities: s.capabilities as string[],
          displayName: s.displayName,
          workspacePath: s.workspacePath ?? null,
          // The same defect as capabilities, one column over. `matrix_id` was
          // written only at adoption, so a station adopted before the mxid
          // reader worked could never gain one — in production that was every
          // station: 32 adopted, 0 with an identity, while `detect` on the same
          // hosts reported them correctly all along.
          //
          // `?? null` rather than a skip-if-absent: an agent whose Matrix
          // identity was removed must lose it here too, or a bridge routes a
          // room message to an mxid nobody answers on.
          matrixId: s.matrixId ?? null,
        })
        .where(and(eq(stations.nodeId, nodeId), eq(stations.stationKey, s.key)));
      updated++;
    }
    return updated;
  } catch (e) {
    console.log(
      `[refresh-caps] failed for node ${nodeId}:`,
      e instanceof Error ? e.message : e
    );
    return 0;
  }
}
