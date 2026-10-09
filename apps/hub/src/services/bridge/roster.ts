/**
 * The bridge's roster, read and written where every other workspace record lives.
 *
 * This replaces `SUPERPIPELINE_BRIDGE_AGENTS` outright. The argument is in
 * `docs/superpowers/specs/2026-09-29-bridge-roster-in-the-database-design.md`; the short form is
 * that four agent identities with two credentials each are workspace data, not deployment
 * configuration, and everything comparable in AgentPod — station adoption, git identities, Matrix
 * credentials — is a tenant-scoped row a human creates in the console.
 *
 * **Two read surfaces, and the split is the point.**
 *
 * - `listBridgeAgents` is what a HUMAN sees. It answers `hasToken`, never the token. There is no
 *   parameter that makes it return one, so no route can be written that leaks one by accident.
 * - `readBridgeRoster` is what the BRIDGE sees. It decrypts, because the loop has to spend the
 *   credential, and it is the only function here that does.
 *
 * **`hubUserId` is derived, not stored.** `getStation(userId, stationId)` filters on
 * `stations.userId`, so a roster entry naming any other user failed every ACP call as "Station not
 * found". A field that can only ever hold one correct value is a field that can only ever be
 * wrong, so it is read from the station instead — which is also why `stationId` carries a
 * composite foreign key rather than a convention.
 */

import { createHash } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { bridgeAgents, type BridgeAgentRow } from "../../db/schema/bridge";
import { stations } from "../../db/schema/stations";
import { createLogger } from "../../utils/logger";
import { superlibraryClient } from "../superlibrary/client";
import { decrypt, encrypt } from "../../utils/encryption";
import type { AcpSessionMode } from "@agentpod/contract";

const log = createLogger("bridge-roster");

/** One roster entry as a human sees it. Deliberately carries no credential. */
export interface BridgeAgentView {
  key: string;
  boardId: string;
  stationId: string;
  /** The station's display name, so a list does not read as a column of opaque ids. */
  stationName: string | null;
  /** Read from the station — the user its ACP sessions belong to. */
  hubUserId: string;
  mode: string;
  permissionWaitMs: number | null;
  maxConcurrency: number | null;
  profileKey: string | null;
  enabled: boolean;
  hasToken: boolean;
  hasMcpToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** One roster entry as the bridge spends it. The only shape carrying plaintext. */
export interface BridgeAgentSecrets {
  key: string;
  boardId: string;
  stationId: string;
  hubUserId: string;
  mode: AcpSessionMode;
  permissionWaitMs: number | null;
  maxConcurrency: number | null;
  profileKey: string | null;
  token: string;
  mcpToken: string | null;
  /**
   * What the reconciler compares to decide a running loop must be rebuilt.
   *
   * A fingerprint of the row's own fields rather than `updatedAt`, because a timestamp is the
   * wrong instrument for this: Drizzle hands back a JS `Date`, whose resolution is a millisecond,
   * and two edits inside one millisecond are indistinguishable by it — which a test caught. A
   * digest answers "is this the same configuration" exactly, and owes nothing to a clock.
   *
   * The ciphertexts are part of it, so rotating a credential restarts the loop that spends it.
   * Re-encrypting the SAME token also changes the digest, because the IV is random; restarting a
   * loop that did not need restarting costs one claim cycle and is the safe direction to err in.
   */
  revision: string;
  updatedAt: Date;
}

export interface CreateBridgeAgentInput {
  tenantId: string;
  key: string;
  boardId: string;
  stationId: string;
  token: string;
  mcpToken?: string | null;
  mode?: string;
  permissionWaitMs?: number | null;
  maxConcurrency?: number | null;
  profileKey?: string | null;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface UpdateBridgeAgentInput {
  boardId?: string;
  stationId?: string;
  token?: string;
  /** `null` clears it, which is how an agent loses its board tools without losing its row. */
  mcpToken?: string | null;
  mode?: string;
  permissionWaitMs?: number | null;
  maxConcurrency?: number | null;
  profileKey?: string | null;
  enabled?: boolean;
}

/**
 * Rows joined to their station, tenant-scoped.
 *
 * The join is an inner one and that is load-bearing: the composite foreign key already makes a
 * station in another tenant unreferencable, so a row with no station here would mean the
 * constraint had been dropped. Failing closed (the agent simply is not rostered) is the right
 * answer to that, and better than claiming work on a station nobody owns.
 */
function rowsFor(tenantId: string) {
  return db
    .select({ agent: bridgeAgents, stationUserId: stations.userId, stationName: stations.displayName })
    .from(bridgeAgents)
    .innerJoin(
      stations,
      and(eq(bridgeAgents.stationId, stations.id), eq(bridgeAgents.tenantId, stations.tenantId)),
    )
    .where(eq(bridgeAgents.tenantId, tenantId))
    .orderBy(asc(bridgeAgents.key));
}

/** Every entry a human may see, enabled or not. No credentials. */
export async function listBridgeAgents(tenantId: string): Promise<BridgeAgentView[]> {
  const rows = await rowsFor(tenantId);
  return rows.map(({ agent, stationUserId, stationName }) => ({
    key: agent.key,
    boardId: agent.boardId,
    stationId: agent.stationId,
    stationName,
    hubUserId: stationUserId,
    mode: agent.mode,
    permissionWaitMs: agent.permissionWaitMs,
    maxConcurrency: agent.maxConcurrency,
    profileKey: agent.profileKey,
    enabled: agent.enabled,
    hasToken: agent.tokenEncrypted.length > 0,
    hasMcpToken: Boolean(agent.mcpTokenEncrypted && agent.mcpTokenEncrypted.length > 0),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  }));
}

/**
 * Every ENABLED entry, with its credentials decrypted, for the bridge to run.
 *
 * A row whose credential will not decrypt is dropped rather than thrown on: one agent with a
 * credential encrypted under a since-changed `ENCRYPTION_KEY` must not stop the other three from
 * claiming. The omission is reported by the caller, which is the loop that can say whose it was.
 */
export async function readBridgeRoster(
  tenantId: string,
  onUnreadable?: (key: string, reason: string) => void,
): Promise<BridgeAgentSecrets[]> {
  const rows = await rowsFor(tenantId);
  const out: BridgeAgentSecrets[] = [];

  for (const { agent, stationUserId } of rows) {
    if (!agent.enabled) continue;
    try {
      out.push({
        key: agent.key,
        boardId: agent.boardId,
        stationId: agent.stationId,
        hubUserId: stationUserId,
        mode: agent.mode as AcpSessionMode,
        permissionWaitMs: agent.permissionWaitMs,
        maxConcurrency: agent.maxConcurrency,
        profileKey: agent.profileKey,
        token: await decrypt(agent.tokenEncrypted),
        mcpToken: agent.mcpTokenEncrypted ? await decrypt(agent.mcpTokenEncrypted) : null,
        revision: revisionOf(agent),
        updatedAt: agent.updatedAt,
      });
    } catch (err) {
      onUnreadable?.(agent.key, err instanceof Error ? err.message : String(err));
    }
  }

  return out;
}

/**
 * A digest of everything a running loop was built from.
 *
 * Deliberately over the CIPHERtexts, not the plaintexts: this runs on every reconcile tick, and
 * decrypting to fingerprint would spend a key operation per agent per tick for no added meaning.
 */
function revisionOf(agent: BridgeAgentRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        agent.boardId,
        agent.stationId,
        agent.mode,
        agent.permissionWaitMs,
        agent.maxConcurrency,
        agent.profileKey,
        agent.enabled,
        agent.tokenEncrypted,
        agent.mcpTokenEncrypted,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export async function createBridgeAgent(input: CreateBridgeAgentInput): Promise<void> {
  await db.insert(bridgeAgents).values({
    tenantId: input.tenantId,
    key: input.key,
    boardId: input.boardId,
    stationId: input.stationId,
    tokenEncrypted: await encrypt(input.token),
    mcpTokenEncrypted: input.mcpToken ? await encrypt(input.mcpToken) : null,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    permissionWaitMs: input.permissionWaitMs ?? null,
    maxConcurrency: input.maxConcurrency ?? null,
    profileKey: input.profileKey ?? null,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    createdBy: input.createdBy ?? null,
  });
  void notifyRosterChanged(input.tenantId, input.stationId);
}

/** Superlibrary caches a roster for five minutes; a change clears it now. Never throws. */
export async function notifyRosterChanged(tenantId: string, stationId: string): Promise<void> {
  try {
    const lib = superlibraryClient();
    if (!lib) return;
    const [s] = await db
      .select({ principalId: stations.principalId })
      .from(stations)
      .where(and(eq(stations.id, stationId), eq(stations.tenantId, tenantId)))
      .limit(1);
    if (s?.principalId) await lib.invalidateRoster(s.principalId);
  } catch (err) {
    log.warn("roster change not sent to Superlibrary", { stationId, error: String(err) });
  }
}

async function stationOf(tenantId: string, key: string): Promise<string | null> {
  const [r] = await db
    .select({ stationId: bridgeAgents.stationId })
    .from(bridgeAgents)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, key)))
    .limit(1);
  return r?.stationId ?? null;
}

/**
 * Change one entry. `updatedAt` always moves, including when a credential is rotated — that
 * timestamp is the entire signal the reconciler restarts a running loop on, so an edit that did
 * not move it would be an edit that never took effect.
 */
export async function updateBridgeAgent(
  tenantId: string,
  key: string,
  patch: UpdateBridgeAgentInput,
): Promise<boolean> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const before = await stationOf(tenantId, key);

  if (patch.boardId !== undefined) set.boardId = patch.boardId;
  if (patch.stationId !== undefined) set.stationId = patch.stationId;
  if (patch.mode !== undefined) set.mode = patch.mode;
  if (patch.permissionWaitMs !== undefined) set.permissionWaitMs = patch.permissionWaitMs;
  if (patch.maxConcurrency !== undefined) set.maxConcurrency = patch.maxConcurrency;
  if (patch.profileKey !== undefined) set.profileKey = patch.profileKey;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.token !== undefined) set.tokenEncrypted = await encrypt(patch.token);
  if (patch.mcpToken !== undefined) {
    set.mcpTokenEncrypted = patch.mcpToken ? await encrypt(patch.mcpToken) : null;
  }

  const done = await db
    .update(bridgeAgents)
    .set(set)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, key)))
    .returning({ key: bridgeAgents.key });

  if (done.length > 0) {
    // A row moved to another station changes both stations' principals.
    for (const id of new Set([before, patch.stationId])) {
      if (id) void notifyRosterChanged(tenantId, id);
    }
  }
  return done.length > 0;
}

export async function deleteBridgeAgent(tenantId: string, key: string): Promise<boolean> {
  const before = await stationOf(tenantId, key);
  const done = await db
    .delete(bridgeAgents)
    .where(and(eq(bridgeAgents.tenantId, tenantId), eq(bridgeAgents.key, key)))
    .returning({ key: bridgeAgents.key });

  if (done.length > 0 && before) void notifyRosterChanged(tenantId, before);
  return done.length > 0;
}
