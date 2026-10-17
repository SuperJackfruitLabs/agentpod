/**
 * The forge API reconcile sweep (spec 2026-10-17-forge-api-access-design, "Reconcile", "Node
 * offline", "Sealed-blob expiry", "Reassignment", "Version skew").
 *
 * It decides WHAT to do from each row (state, reason, `token_handle`, blob) and does it ONLY through
 * the lifecycle service in `station-forge-api.ts`, so every step is claim-guarded (`withGrantClaim`;
 * `grant-busy` is skipped and reported), idempotent and resumable. Per grant, in order:
 *
 *   revoking                                → revokeGrant (wipe first, then the provider; a gone
 *                                             station ends `revoked` once the provider side is done)
 *   no station (and not revoking)           → revokeGrant
 *   previous:`revoke` or an `orphan` handle → revokeStrayHandles (no node needed)
 *   rotating (previous live-until-verified):
 *     blob present but expired              → undoExpiredRotation (no node needed)
 *     otherwise                             → verifyGrant — which re-sends a live blob, finishes an
 *                                             acked one, and UNDOES a crash-before-seal rotation.
 *                                             Never deliverGrant: it returns such a row unchanged.
 *   minted, never delivered (authorised/provisioned/failed, delivered_at NULL)
 *                                           → deliverGrant (live blob: re-send, no re-mint; expired
 *                                             or missing blob: revoke + mint generation + 1)
 *   supplied/app, not delivered, live blob  → deliverGrant (re-send)
 *   delivered/verified with a live blob     → deliverGrant (re-send the unacknowledged credential)
 *   delivered/verified, policy_pending_since set → updateGrantPolicy with the row's own policy
 *
 * Anything that sends a frame needs the node online AND advertising `forge.api`; otherwise it is
 * skipped and reported (`node-offline`, `node-lacks-forge.api`). One grant's failure never stops
 * the sweep: errors are collected, by code and a bounded, scrubbed message.
 *
 * ORPHAN SCAN (full sweeps only): for each (provider, instance, account) with minted grants, the
 * provider's tokens named `agentpod-*` that match no live row's current, previous or orphan handle
 * are REPORTED — in the report and once per hub process in the audit log
 * (`forge.api.reconcile.orphan`). Never deleted here: a name match is not proof of ownership.
 *
 * REPEATED FAILURES: an in-memory tracker (per hub process; a restart forgets it, which only delays
 * the next report) counts consecutive sweeps in which a grant failed with the SAME signature
 * (`<action>:<code>`). At the third it writes one `forge.api.reconcile.failing` audit row; the grant
 * stays in `repeatedFailures` until it stops failing. Audit, not a page.
 *
 * Scheduling: every 5 minutes (unref'd, never overlapping) and on `connectionManager.onNodeOnline`
 * for that node's grants, the same way `configureGitAuthorSync` hooks reconnects.
 */
import { and, eq, ne } from "drizzle-orm";

import type { ForgeApiProvider } from "@agentpod/contract";

import { db as defaultDb } from "../db/drizzle";
import { stationForgeApiGrants as g, type StationForgeApiGrant as Grant } from "../db/schema/forge-api-grants";
import { stations } from "../db/schema/stations";
import { createLogger } from "../utils/logger";
import { recordAudit } from "./audit";
import { connectionManager } from "./connection-manager";
import * as broker from "./broker";
import type { ForgeConfig } from "./forge";
import { getProvider } from "./forge-api/providers";
import {
  blobIsLive,
  deliverGrant,
  ForgeApiGrantError,
  revokeGrant,
  revokeStrayHandles,
  rotationOf,
  undoExpiredRotation,
  untrusted,
  updateGrantPolicy,
  verifyGrant,
  VERIFY_PENDING,
  type ForgeApiDeps,
} from "./station-forge-api";

const log = createLogger("forge-api-reconcile");

export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** Consecutive same-signature failures before the audit log hears of it. */
export const REPEATED_FAILURE_THRESHOLD = 3;
const AUDIT_ACTOR = "system:forge-reconcile";

export type FailureTracker = Map<string, { sig: string; count: number }>;
export const createFailureTracker = (): FailureTracker => new Map();
const defaultFailures = createFailureTracker();
/** Orphans already written to the audit log by this process (the report always lists them). */
const reportedOrphans = new Set<string>();

export interface ReconcileDeps extends ForgeApiDeps {
  /** Only this node's grants (the onNodeOnline path). Absent: every grant, plus the orphan scan. */
  nodeId?: string;
  /** Defaults to the connection manager. */
  isNodeOnline?: (nodeId: string) => boolean;
  failures?: FailureTracker;
}

export type ReconcileAction = "revoke" | "revoke-stray" | "undo-rotation" | "verify" | "deliver" | "policy";

export interface ReconcileReport {
  scanned: number;
  actions: { grantId: string; action: ReconcileAction; outcome: string }[];
  skipped: { grantId: string; why: string }[];
  errors: { grantId: string; action: ReconcileAction; error: string }[];
  orphans: { provider: ForgeApiProvider; instance: string; account: string; name: string }[];
  /** Accounts the orphan scan could not check: their provider cannot list tokens. */
  orphanScanUnsupported: { provider: ForgeApiProvider; instance: string; account: string }[];
  /** Grants that have failed the same way in REPEATED_FAILURE_THRESHOLD or more consecutive sweeps. */
  repeatedFailures: string[];
}

type Step = { action: ReconcileAction; needsNode: boolean };

/** What one grant needs next, from the row alone. Null: nothing. */
function nextStep(row: Grant, now: Date): Step | null {
  if (row.state === "revoked") return null;
  if (row.state === "revoking" || row.stationId === null) return { action: "revoke", needsNode: false };
  const h = row.tokenHandle;
  if (h && (h.previous?.disposition === "revoke" || h.orphan)) return { action: "revoke-stray", needsNode: false };
  if (rotationOf(row).rotating) {
    if (row.sealedBlob && !blobIsLive(row, now)) return { action: "undo-rotation", needsNode: false };
    return { action: "verify", needsNode: true };
  }
  const settled = row.state === "delivered" || row.state === "verified";
  if (!settled) {
    if (row.mode === "minted" && row.deliveredAt === null) return { action: "deliver", needsNode: true };
    if (blobIsLive(row, now)) return { action: "deliver", needsNode: true };
    return null;
  }
  if (blobIsLive(row, now)) return { action: "deliver", needsNode: true };
  if (row.stateReason?.includes(VERIFY_PENDING)) return { action: "verify", needsNode: true };
  // The flag, not the reason: a lifecycle reason (rotation-failed, …) must not hide a policy the
  // node never confirmed.
  if (row.policyPendingSince !== null) return { action: "policy", needsNode: true };
  return null;
}

/** Run one step through the lifecycle service. Returns the outcome and, when it failed, a code. */
async function act(deps: ForgeApiDeps, row: Grant, step: Step): Promise<{ outcome: string; failure?: string }> {
  const ref = { tenantId: row.tenantId, grantId: row.id };
  switch (step.action) {
    case "revoke": {
      const r = await revokeGrant(deps, ref);
      return r.outcome === "pending" ? { outcome: r.outcome, failure: "provider-pending" } : { outcome: r.outcome };
    }
    case "revoke-stray": {
      const r = await revokeStrayHandles(deps, ref);
      return { outcome: `revoked ${r.revoked.length}` };
    }
    case "undo-rotation": {
      const r = await undoExpiredRotation(deps, ref);
      return { outcome: r.stateReason?.startsWith("rotation-failed") ? "rotation-undone" : "unchanged" };
    }
    case "verify": {
      const r = await verifyGrant(deps, ref);
      return r.outcome === "failed" ? { outcome: r.outcome, failure: "verify-failed" } : { outcome: r.outcome };
    }
    case "deliver": {
      const r = await deliverGrant(deps, ref);
      if (r.state === "delivered" || r.state === "verified") return { outcome: r.state };
      return { outcome: r.state, failure: r.state === "failed" ? "deliver-failed" : "deliver-pending" };
    }
    case "policy": {
      const r = await updateGrantPolicy(deps, { ...ref, preset: row.preset, rules: row.rules as never, allowGraphql: row.allowGraphql });
      return r.outcome === "policy-pending" ? { outcome: r.outcome, failure: "policy-pending" } : { outcome: r.outcome };
    }
  }
}

async function auditSystem(
  deps: Pick<ForgeApiDeps, "db">,
  where: { nodeId: string; stationKey: string },
  verb: string,
  params: Record<string, unknown>,
  error?: string,
): Promise<void> {
  try {
    const a = await recordAudit(deps.db, { userId: AUDIT_ACTOR, ...where, verb, params });
    await a.done(error ? "error" : "ok", error);
  } catch (err) {
    log.warn("forge reconcile could not write an audit row", { verb, error: untrusted(String((err as Error)?.message ?? err)) });
  }
}

/** One sweep. Never throws for a grant; throws only if the grants cannot be read at all. */
export async function runForgeApiReconcile(deps: ReconcileDeps): Promise<ReconcileReport> {
  const failures = deps.failures ?? defaultFailures;
  const isOnline = deps.isNodeOnline ?? ((id: string) => connectionManager.isOnline(id));
  const report: ReconcileReport = { scanned: 0, actions: [], skipped: [], errors: [], orphans: [], orphanScanUnsupported: [], repeatedFailures: [] };
  const rows = await deps.db
    .select({ grant: g, nodeId: stations.nodeId, capabilities: stations.capabilities })
    .from(g)
    .leftJoin(stations, eq(stations.id, g.stationId))
    .where(deps.nodeId ? and(ne(g.state, "revoked"), eq(stations.nodeId, deps.nodeId)) : ne(g.state, "revoked"));
  report.scanned = rows.length;

  for (const { grant: row, nodeId, capabilities } of rows) {
    const step = nextStep(row, deps.now());
    if (!step) {
      failures.delete(row.id);
      continue;
    }
    if (step.needsNode) {
      if (!nodeId || !isOnline(nodeId)) {
        report.skipped.push({ grantId: row.id, why: "node-offline" });
        continue;
      }
      if (!(capabilities ?? []).includes("forge.api")) {
        report.skipped.push({ grantId: row.id, why: "node-lacks-forge.api" });
        continue;
      }
    }
    let failure: string | undefined;
    try {
      const out = await act(deps, row, step);
      report.actions.push({ grantId: row.id, action: step.action, outcome: out.outcome });
      failure = out.failure;
    } catch (err) {
      if (err instanceof ForgeApiGrantError && err.code === "grant-busy") {
        report.skipped.push({ grantId: row.id, why: "grant-busy" });
        continue;
      }
      const code = err instanceof ForgeApiGrantError ? err.code : "error";
      // Service errors are built from ids and scrubbed text; bound and strip them anyway.
      const message = untrusted(err instanceof Error ? err.message : String(err));
      report.errors.push({ grantId: row.id, action: step.action, error: `${code}: ${message}` });
      failure = code;
    }
    if (!failure) {
      failures.delete(row.id);
      continue;
    }
    const sig = `${step.action}:${failure}`;
    const prev = failures.get(row.id);
    const count = prev?.sig === sig ? prev.count + 1 : 1;
    failures.set(row.id, { sig, count });
    if (count >= REPEATED_FAILURE_THRESHOLD) {
      report.repeatedFailures.push(row.id);
      if (count === REPEATED_FAILURE_THRESHOLD) {
        log.warn("forge grant keeps failing in reconcile", { grantId: row.id, action: step.action, failure, sweeps: count });
        await auditSystem(
          deps,
          { nodeId: nodeId ?? "", stationKey: row.stationIdSnapshot },
          "forge.api.reconcile.failing",
          { grantId: row.id, provider: row.provider, mode: row.mode, action: sig, size: count },
          failure,
        );
      }
    }
  }

  if (!deps.nodeId) await orphanScan(deps, report);
  return report;
}

/** Report provider tokens named `agentpod-*` that no grant row knows. Never deletes. */
async function orphanScan(deps: ForgeApiDeps, report: ReconcileReport): Promise<void> {
  const rows = await deps.db.select().from(g).where(eq(g.mode, "minted"));
  type Entry = { provider: ForgeApiProvider; instance: string; account: string; names: Set<string>; ids: Set<number> };
  const accounts = new Map<string, Entry>();
  for (const row of rows) {
    const key = JSON.stringify([row.provider, row.instance, row.account]);
    let entry = accounts.get(key);
    if (!entry) {
      entry = { provider: row.provider, instance: row.instance, account: row.account, names: new Set(), ids: new Set() };
      accounts.set(key, entry);
    }
    // A revoked tombstone's token should be gone; if the provider still lists it, that is an orphan.
    if (row.state === "revoked") continue;
    const h = row.tokenHandle;
    // Accounted for if EITHER its name or its id matches a recorded handle.
    for (const ref of [h, h?.previous, h?.orphan]) {
      if (!ref) continue;
      entry.names.add(ref.name);
      if (typeof ref.id === "number") entry.ids.add(ref.id);
    }
  }
  for (const entry of accounts.values()) {
    let listed: { id?: number; name: string }[];
    try {
      const provider = deps.providers(entry.provider);
      if (!provider.listTokens) {
        report.orphanScanUnsupported.push({ provider: entry.provider, instance: entry.instance, account: entry.account });
        continue;
      }
      listed = await provider.listTokens(entry.account);
    } catch (err) {
      report.errors.push({
        grantId: "",
        action: "revoke",
        error: `orphan-scan: ${untrusted(err instanceof Error ? err.message : String(err))}`,
      });
      continue;
    }
    for (const t of listed) {
      if (!t.name.startsWith("agentpod-") || entry.names.has(t.name)) continue;
      if (typeof t.id === "number" && entry.ids.has(t.id)) continue;
      const orphan = { provider: entry.provider, instance: entry.instance, account: entry.account, name: t.name };
      report.orphans.push(orphan);
      const seen = JSON.stringify(orphan);
      if (reportedOrphans.has(seen)) continue;
      reportedOrphans.add(seen);
      log.warn("forge token with no grant row found (reported, not deleted)", { account: entry.account, tokenName: t.name });
      await auditSystem(deps, { nodeId: "", stationKey: `forge:${entry.instance}` }, "forge.api.reconcile.orphan", {
        provider: entry.provider,
        username: entry.account,
        key: t.name,
      });
    }
  }
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

let current: ReconcileDeps | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let hookInstalled = false;
/** The post-commit kick: tries per grant on `grant-busy`, base backoff (doubling). */
const KICK_RETRIES = 3;
const KICK_BACKOFF_MS = 250;
let kickBackoffMs = KICK_BACKOFF_MS;

/** The service deps a hub with a configured forge uses (the routes build the same). */
export function forgeApiServiceDeps(forge: ForgeConfig): ForgeApiDeps {
  return {
    db: defaultDb,
    broker,
    providers: (kind) => getProvider(kind, { cfg: forge }),
    now: () => new Date(),
    forgeOrigin: forge.baseUrl,
    seal: async (pk, material) => (await import("./handover-seal")).sealHandover(pk, material),
  };
}

/**
 * One scheduled sweep over every grant. Null when not configured or when a sweep is already
 * running (the overlap guard: ticks never stack up behind a slow forge).
 */
export async function tickForgeApiReconcile(): Promise<ReconcileReport | null> {
  const deps = current;
  if (!deps || running) return null;
  running = true;
  try {
    return await runForgeApiReconcile({ ...deps, nodeId: undefined });
  } finally {
    running = false;
  }
}

/**
 * Turn reconcile on (deps) or off (null). Installs the onNodeOnline hook once (it reads whatever was
 * configured last, like `configureGitAuthorSync`), and, unless `schedule: false`, an unref'd
 * interval that is cleared by the next call. Only call it with deps when a forge is configured.
 */
export function configureForgeApiReconcile(
  deps: ReconcileDeps | null,
  opts: { schedule?: boolean; intervalMs?: number; kickBackoffMs?: number } = {},
): void {
  current = deps;
  kickBackoffMs = opts.kickBackoffMs ?? KICK_BACKOFF_MS;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (deps && opts.schedule !== false) {
    timer = setInterval(() => {
      tickForgeApiReconcile().catch((err) => {
        log.warn("forge api reconcile failed", { error: untrusted(String((err as Error)?.message ?? err)) });
      });
    }, opts.intervalMs ?? RECONCILE_INTERVAL_MS);
    timer.unref?.();
  }
  if (hookInstalled) return;
  hookInstalled = true;
  connectionManager.onNodeOnline((nodeId) => {
    const deps = current;
    if (!deps) return;
    // A rejection is logged, never thrown into registration (the connection manager also guards).
    Promise.resolve()
      .then(() => runForgeApiReconcile({ ...deps, nodeId }))
      .catch((err) => {
        log.warn("forge api reconcile failed", { nodeId, error: untrusted(String((err as Error)?.message ?? err)) });
      });
  });
}

/** Is the periodic sweep scheduled? (Tests use it to prove stop leaves no timer behind.) */
export function forgeApiReconcileTimerActive(): boolean {
  return timer !== null;
}

/**
 * After an occupancy change has COMMITTED: start revoking these grants now, out of band, so the
 * node wipe cuts access at once instead of at the next sweep. Never awaited by the caller, never
 * throws; a no-op when reconcile is not configured (the sweep still gets them).
 */
export function kickForgeApiRevoke(refs: { tenantId: string; grantId: string }[]): void {
  const deps = current;
  if (!deps || refs.length === 0) return;
  const backoff = kickBackoffMs;
  void (async () => {
    for (const ref of refs) {
      try {
        // A step already holding the grant's claim (a rotation, a delivery) finishes first; retry
        // a few times before leaving it to the sweep.
        for (let attempt = 0; ; attempt++) {
          try {
            await revokeGrant(deps, ref);
            break;
          } catch (err) {
            const busy = err instanceof ForgeApiGrantError && err.code === "grant-busy";
            if (!busy || attempt >= KICK_RETRIES - 1) throw err;
            await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
          }
        }
      } catch (err) {
        log.warn("forge grant revoke after an occupancy change deferred to reconcile", {
          grantId: ref.grantId,
          error: untrusted(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  })();
}
