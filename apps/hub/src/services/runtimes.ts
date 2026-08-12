/**
 * Fleet-era runtime provisioning service (P4 Task 8).
 *
 * Orchestrates the full lifecycle of a provisioned runtime:
 *   create → mint-token → provision-driver → persist externalId
 *   destroy → driver.destroy → mark destroyed
 *   start / stop → driver.start/stop (guard on capability)
 *
 * Status honesty: `online` means "a node for this runtime is connected" and is
 * written only by enrolment (enrollment.ts). Everything here can say at most
 * "the substrate accepted my request" — hence `provisioning` / `starting`, and
 * sweepStalledRuntimeStarts() to expire the ones that never come back.
 *
 * `stopped` is the same rule at the other end: it means "the substrate says the
 * container is down", so it is written only on the substrate's own answer
 * (RuntimeProvisioner.status), never because stop() resolved. In between comes
 * `stopping`, reconciled by sweepStalledRuntimeStops().
 *
 * Error semantics for routes:
 *   - "provider disabled: X"     → 400 (user chose a disabled provider)
 *   - "provider not registered"  → 400 (same surface — misconfigured)
 *   - "unsupported operation"    → 400 (start/stop not supported by driver)
 *   - "not found"                → 404
 *   - driver provision() throw   → status set to "error"; rethrow (→ 502)
 */

import { and, eq, inArray, isNotNull, lt, ne } from "drizzle-orm";
import { db } from "../db/drizzle";
import { provisionedRuntimes, nodes } from "../db/schema/nodes";
import { mintEnrollmentToken } from "./enrollment";
import {
  getProvisioner,
  getProvisionerUnguarded,
  enabledProviders,
  providerManifests,
  isProviderEnabled,
} from "./provisioner/registry";
import type { ProvisionedRuntime } from "@agentpod/contract";
import type { RuntimeProvisioner, RuntimeState } from "./provisioner/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const prefixedId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * Resolve the container image for a given harness.
 * Image resolution lives in the service layer so drivers are image-agnostic —
 * they receive the resolved image via ProvisionSpec.image.
 *
 * Env overrides allow operators to pin specific image tags per harness:
 *   NODE_AGENT_OPENCODE_IMAGE — opencode harness (default: agentpod-node-opencode:local)
 *   NODE_AGENT_PI_IMAGE       — pi harness      (default: agentpod-node-pi:local)
 *   NODE_AGENT_IMAGE          — generic / no harness (default: agentpod-node:local)
 */
function imageForHarness(harness: string): string {
  if (harness === "opencode") {
    return process.env.NODE_AGENT_OPENCODE_IMAGE ?? "agentpod-node-opencode:local";
  }
  if (harness === "pi") {
    return process.env.NODE_AGENT_PI_IMAGE ?? "agentpod-node-pi:local";
  }
  return process.env.NODE_AGENT_IMAGE ?? "agentpod-node:local";
}

type RuntimeRow = typeof provisionedRuntimes.$inferSelect;

function toContract(row: RuntimeRow): ProvisionedRuntime {
  return {
    id: row.id,
    ownerId: row.userId,
    provider: row.provider as ProvisionedRuntime["provider"],
    externalId: row.externalId ?? null,
    status: row.status as ProvisionedRuntime["status"],
    nodeId: row.nodeId ?? null,
    name: row.name,
    resourceTier: row.resourceTier as ProvisionedRuntime["resourceTier"],
    harness: (row.harness ?? "none") as ProvisionedRuntime["harness"],
    runtime: row.runtime ?? null,
    statusReason: row.statusReason ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Create a new provisioned runtime for the user.
 *
 * Flow:
 *   1. Validate the provider is enabled.
 *   2. Insert a `provisioning` row.
 *   3. Mint a one-time enrollment token linked to the row.
 *   4. Call the driver's provision() — injects hubUrl + token into the container env.
 *   5. On success: persist externalId.
 *   6. On driver failure: set status to "error" then rethrow.
 */
export async function createRuntime(
  userId: string,
  req: { provider: string; name: string; resourceTier: string; harness?: string },
  hubUrl: string
): Promise<ProvisionedRuntime> {
  const provider = req.provider;

  // Guard — 400 before anything is written.
  //
  // This is where the provider enum's validation went. The contract accepts any
  // non-empty name now, so a name this deployment has not enabled — including
  // one no driver has ever registered, whose env flag therefore cannot be set —
  // is refused here, before a runtime row, an enrolment token or a driver call
  // exists. getProvisioner() below is the second half of the same check: it
  // refuses a name nothing registered under.
  if (!isProviderEnabled(provider)) {
    throw Object.assign(
      new Error(`provider disabled: ${provider}`),
      { status: 400 }
    );
  }

  const id = prefixedId("rt");
  const now = new Date();

  const harness = req.harness ?? "none";

  await db.insert(provisionedRuntimes).values({
    id,
    userId,
    provider,
    status: "provisioning",
    name: req.name,
    resourceTier: req.resourceTier ?? "small",
    harness,
    externalId: null,
    nodeId: null,
    createdAt: now,
    updatedAt: now,
  });

  // Mint an enrollment token linked to this runtime. The node-agent container
  // uses it to self-enroll and flip the runtime online.
  //
  // No ttlMs override: a runtime-bound token gets the durable
  // RUNTIME_TOKEN_TTL_MS default on purpose. On an ephemeral-disk substrate the
  // container's config does not survive a restart, so it re-presents this same
  // token on EVERY boot — an expiry would mean a runtime that silently loses
  // the ability to come back after its first sleep. The token is revoked by
  // destroying the runtime, not by waiting.
  let enrollToken: string;
  try {
    const result = await mintEnrollmentToken(userId, {
      provisionedRuntimeId: id,
    });
    enrollToken = result.token;
  } catch (err) {
    await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason: `could not mint an enrolment token: ${(err as Error).message}`,
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, id));
    throw Object.assign(err as Error, { status: 502 });
  }

  let provisioner: ReturnType<typeof getProvisioner>;
  try {
    provisioner = getProvisioner(provider);
  } catch (err) {
    // Driver not registered (env flag on but no driver wired) → 400
    await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason: (err as Error).message,
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, id));
    throw Object.assign(err as Error, { status: 400 });
  }

  try {
    const { externalId, runtime } = await provisioner.provision({
      runtimeId: id,
      name: req.name,
      resourceTier: (req.resourceTier ?? "small") as "small" | "medium" | "large",
      hubUrl,
      enrollToken,
      image: imageForHarness(harness),
    });

    await db
      .update(provisionedRuntimes)
      .set({ externalId, runtime: runtime ?? null, updatedAt: new Date() })
      .where(eq(provisionedRuntimes.id, id));

    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, id));

    return toContract(row!);
  } catch (err) {
    await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason: `the ${provider} driver failed to provision it: ${(err as Error).message}`,
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, id));
    // Surface as 502 — the driver (external system) failed
    throw Object.assign(err as Error, { status: 502 });
  }
}

/**
 * List a user's live provisioned runtimes.
 *
 * Destroyed rows stay in the DB for history but are excluded here: no action
 * can be taken on a destroyed runtime, so surfacing it gives the console a
 * permanent dead row.
 */
export async function listRuntimes(userId: string): Promise<ProvisionedRuntime[]> {
  const rows = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(
        eq(provisionedRuntimes.userId, userId),
        ne(provisionedRuntimes.status, "destroyed")
      )
    );

  return rows.map(toContract);
}

/**
 * Get a single runtime, owner-scoped. Returns null if not found or wrong user.
 */
export async function getRuntime(
  userId: string,
  id: string
): Promise<ProvisionedRuntime | null> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(eq(provisionedRuntimes.id, id), eq(provisionedRuntimes.userId, userId))
    );

  return row ? toContract(row) : null;
}

/**
 * Permanently destroy a runtime and mark it destroyed in the DB.
 * Throws 404 if not found or owned by another user.
 * Throws 502 if the driver destroy() fails.
 */
export async function destroyRuntime(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(eq(provisionedRuntimes.id, id), eq(provisionedRuntimes.userId, userId))
    );

  if (!row) {
    throw Object.assign(new Error("runtime not found"), { status: 404 });
  }

  if (row.externalId) {
    const provisioner = getProvisionerUnguarded(row.provider);
    if (provisioner) {
      try {
        await provisioner.destroy(row.externalId);
      } catch (err) {
        throw Object.assign(err as Error, { status: 502 });
      }
    }
    // If no provisioner is registered (driver removed), skip the driver call
    // but still mark the row destroyed — don't leave it dangling.
  }

  await db
    .update(provisionedRuntimes)
    .set({ status: "destroyed", updatedAt: new Date() })
    .where(eq(provisionedRuntimes.id, id));

  // Remove the provisioned node so it disappears from the fleet — a destroyed
  // runtime must not linger as a ghost "offline" node. stations cascade-delete,
  // and provisioned_runtimes.node_id is FK-nulled (onDelete: set null), so the
  // runtime row remains for history with a null node_id. station_audit rows are
  // kept (no FK) but won't surface in the UI once their stations are gone.
  if (row.nodeId) {
    await db.delete(nodes).where(eq(nodes.id, row.nodeId));
  }
}

/**
 * Start (or wake) a runtime. Throws 400 if the driver has no start() support.
 *
 * Leaves the runtime `starting`, never `online`: see the comment on the write.
 * A wake takes the same path, so an asleep runtime goes asleep → starting →
 * online (or → error, if the substrate says yes and nothing comes back).
 */
export async function startRuntime(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(eq(provisionedRuntimes.id, id), eq(provisionedRuntimes.userId, userId))
    );

  if (!row) {
    throw Object.assign(new Error("runtime not found"), { status: 404 });
  }

  const provisioner = getProvisionerUnguarded(row.provider);
  if (!provisioner) {
    throw Object.assign(
      new Error(`provider not available: ${row.provider}`),
      { status: 502 }
    );
  }
  if (!provisioner.start) {
    throw Object.assign(
      new Error(`provider ${row.provider} does not support start`),
      { status: 400 }
    );
  }

  if (!row.externalId) {
    throw Object.assign(new Error("runtime has no external id"), { status: 400 });
  }

  await provisioner.start(row.externalId);

  // NOT "online". All we know is that the substrate accepted a start request;
  // whether a node exists is a different question, and only enrolment can
  // answer it (see enrollment.ts, the evidence-based writer of "online").
  //
  // On 2026-08-12 this line claimed online for a container that crash-exited in
  // 892 ms, and the operator restarted it twice on the strength of that claim.
  // `starting` is the honest state, and sweepStalledRuntimeStarts() below walks
  // it back to `error` with a reason when no node ever arrives.
  await db
    .update(provisionedRuntimes)
    .set({ status: "starting", statusReason: null, updatedAt: new Date() })
    .where(eq(provisionedRuntimes.id, id));
}

/**
 * How long a runtime may sit in `starting`/`provisioning` before the hub
 * concludes its node is never coming.
 *
 * A node-agent enrols within seconds of its container booting, so two minutes
 * is many times the honest worst case (cold image pull excluded — see below)
 * while still answering the operator's question in the time they would spend
 * staring at the console.
 */
export const START_TIMEOUT_MS = 2 * 60_000;

const humanMs = (ms: number) =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;

/**
 * Expire runtimes that were asked to run and never came back.
 *
 * "Started but never came back" is the most common way a provisioned runtime
 * fails and used to be invisible: `starting`/`provisioning` had no exit except
 * a node arriving, so a runtime whose container died on boot sat there — or,
 * before #254, sat there lying about being `online`.
 *
 * Deliberately narrow:
 *   - Only `starting` and `provisioning` are considered. `asleep` is a healthy
 *     state whose node is legitimately offline and must never be reclassified
 *     as failed; `stopped`/`online`/`error`/`destroyed` are not waiting on
 *     anything.
 *   - Only rows with an externalId. Between the insert and provision()
 *     resolving there is no container yet, so a slow image pull is not a
 *     failure.
 *   - The write is a compare-and-set on the status we read. A node that enrols
 *     mid-sweep wins: evidence always beats a timeout.
 *
 * Not terminal — a late enrolment still flips the runtime to `online`.
 *
 * @param now injectable clock for tests.
 * @returns the ids actually flipped to `error`.
 */
export async function sweepStalledRuntimeStarts(
  now: number = Date.now()
): Promise<string[]> {
  const cutoff = new Date(now - START_TIMEOUT_MS);

  const stalled = await db
    .select({ id: provisionedRuntimes.id, status: provisionedRuntimes.status })
    .from(provisionedRuntimes)
    .where(
      and(
        inArray(provisionedRuntimes.status, ["starting", "provisioning"]),
        isNotNull(provisionedRuntimes.externalId),
        lt(provisionedRuntimes.updatedAt, cutoff)
      )
    );

  const expired: string[] = [];
  for (const row of stalled) {
    const verb = row.status === "starting" ? "the start request" : "provisioning";
    const flipped = await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason:
          `no node enrolled within ${humanMs(START_TIMEOUT_MS)} of ${verb} — ` +
          `the container was asked to run but never came back ` +
          `(check the substrate's container logs)`,
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(provisionedRuntimes.id, row.id),
          eq(provisionedRuntimes.status, row.status)
        )
      )
      .returning({ id: provisionedRuntimes.id });

    if (flipped.length > 0) {
      expired.push(row.id);
      console.log(`[runtime-sweeper] ${row.id} ${row.status} → error (no node enrolled)`);
    }
  }

  return expired;
}

/**
 * Ask a driver whether a container is running, without ever letting the answer
 * (or the lack of one) break the caller.
 *
 * A probe that throws is not evidence of anything, so it degrades to `unknown`
 * — which is the honest answer and the one the callers are written to handle.
 * This is deliberately NOT a failure path: a broken probe must not turn a stop
 * that worked into a 502, and must not be mistaken for confirmation either.
 */
async function probeState(
  provisioner: RuntimeProvisioner,
  externalId: string
): Promise<RuntimeState> {
  if (!provisioner.status) return "unknown";
  try {
    return await provisioner.status(externalId);
  } catch (err) {
    console.warn(
      `[runtimes] ${provisioner.provider} status(${externalId}) failed: ${(err as Error).message}`
    );
    return "unknown";
  }
}

/**
 * Stop a runtime. Throws 400 if the driver has no stop() support.
 *
 * Writes `stopped` ONLY on the substrate's own evidence.
 *
 * The sibling of #254, and the more expensive half: an operator who stops a
 * runtime and reads `stopped` concludes the meter stopped. This function used
 * to write that word because `provisioner.stop()` resolved — a statement about
 * a request being accepted, not about a container being down. A stop that did
 * not take left a 4 GiB Cloudflare station (~$28/month) billing behind a
 * console that said it was off.
 *
 * There is no evidence source to borrow the way `starting` borrows enrolment:
 * **the absence of a node does not mean a container stopped.** Nodes go offline
 * for network reasons all the time while their container runs on. Only the
 * substrate can confirm a stop, which is what RuntimeProvisioner.status() is
 * for, and it is substrate-specific.
 *
 * So: `stopping` first, then confirm.
 *   - substrate says stopped     → `stopped` (the evidence path)
 *   - substrate says running     → stays `stopping`; the sweeper keeps asking
 *   - substrate will not say     → stays `stopping`; the sweeper keeps asking
 *   - driver has no status()     → `stopped`, with the caveat recorded (below)
 */
export async function stopRuntime(userId: string, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(eq(provisionedRuntimes.id, id), eq(provisionedRuntimes.userId, userId))
    );

  if (!row) {
    throw Object.assign(new Error("runtime not found"), { status: 404 });
  }

  const provisioner = getProvisionerUnguarded(row.provider);
  if (!provisioner) {
    throw Object.assign(
      new Error(`provider not available: ${row.provider}`),
      { status: 502 }
    );
  }
  if (!provisioner.stop) {
    throw Object.assign(
      new Error(`provider ${row.provider} does not support stop`),
      { status: 400 }
    );
  }

  if (!row.externalId) {
    throw Object.assign(new Error("runtime has no external id"), { status: 400 });
  }

  await provisioner.stop(row.externalId);

  // A driver that cannot report container state can never confirm this stop, so
  // waiting for confirmation would strand the runtime in `stopping` forever —
  // a different lie, and a worse one, since nothing would ever resolve it.
  // `stopped` it is, with the caveat written down where the console shows it
  // (statusReason renders under the badge). Not silent, not stranded, and not a
  // claim dressed up as a fact.
  if (!provisioner.status) {
    await db
      .update(provisionedRuntimes)
      .set({
        status: "stopped",
        statusReason:
          `unverified: the ${row.provider} driver cannot report container state, so ` +
          `the hub knows only that the stop request was accepted — check the ` +
          `substrate if this runtime must not be billing`,
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, id));
    return;
  }

  // Honest in the gap, and crash-safe: if the probe below never returns, the row
  // already says `stopping` and the sweeper picks it up.
  await db
    .update(provisionedRuntimes)
    .set({ status: "stopping", statusReason: null, updatedAt: new Date() })
    .where(eq(provisionedRuntimes.id, id));

  // Docker's stop() blocks until the container is down, so this usually
  // confirms immediately and the operator never sees `stopping` at all.
  // Cloudflare's returns as soon as the container is signalled, so that one
  // resolves on a later sweeper tick.
  const state = await probeState(provisioner, row.externalId);
  if (state === "stopped") {
    await confirmStopped(id);
  }
}

/**
 * Compare-and-set `stopping` → `stopped`.
 *
 * Guarded on the status we read so evidence still beats us: a node that enrols
 * mid-flight has already written `online`, and this must not stomp it.
 */
async function confirmStopped(id: string): Promise<boolean> {
  const flipped = await db
    .update(provisionedRuntimes)
    .set({ status: "stopped", statusReason: null, updatedAt: new Date() })
    .where(
      and(
        eq(provisionedRuntimes.id, id),
        eq(provisionedRuntimes.status, "stopping")
      )
    )
    .returning({ id: provisionedRuntimes.id });
  return flipped.length > 0;
}

/**
 * How long a runtime may sit in `stopping` before the hub reports that the stop
 * was never confirmed.
 *
 * Longer than START_TIMEOUT_MS because stopping legitimately takes longer than
 * starting: a Cloudflare container archives its workspace to R2 on SIGTERM
 * (see cloudflare/worker-v2/src/snapshot.ts), and Cloudflare allows up to 15
 * minutes before SIGKILL. Five minutes is well past a normal stop on either
 * substrate while still landing inside the window in which an operator cares
 * about the bill.
 *
 * The timeout is only ever the bad case: confirmation is accepted on any tick,
 * so an ordinary stop resolves within ~15s of the container actually exiting.
 */
export const STOP_TIMEOUT_MS = 5 * 60_000;

/**
 * Reconcile runtimes that are `stopping`.
 *
 * Runs on the node-sweeper's 15s tick alongside sweepStalledRuntimeStarts —
 * the same idea from the other end: a runtime that was asked to stop and has
 * not been seen to.
 *
 *   - substrate says stopped  → `stopped`, at any age. Evidence is welcome the
 *     moment it exists; the timeout is not a waiting period.
 *   - substrate says running, past STOP_TIMEOUT_MS → `error` with a reason
 *     naming the money: it is still up, and something needs a human.
 *   - substrate will not say, past STOP_TIMEOUT_MS → `error` too. This is the
 *     deliberate choice for `unknown`: the hub HAS a channel to the substrate
 *     and is getting no answer from it (an un-redeployed Cloudflare worker, a
 *     sandbox the substrate has forgotten). Writing `stopped` there is the exact
 *     bug this fixes, and leaving it `stopping` forever hides an anomaly behind
 *     a spinner. Before the timeout `unknown` is left alone, so a transient
 *     blip resolves on a later tick instead of crying wolf.
 *
 * Deliberately narrow, for the same reasons as the start sweep:
 *   - Only `stopping`. `asleep` is a healthy, un-billed state — a sleeping
 *     Cloudflare runtime is not a failed stop and must never be swept.
 *   - Only rows with an externalId; there is nothing to ask about without one.
 *   - Every write is a compare-and-set on the status we read.
 *
 * `error` is not terminal: Start and Destroy both remain available, and a start
 * clears the reason.
 *
 * @param now injectable clock for tests.
 * @returns the ids confirmed stopped, and the ones that timed out unconfirmed.
 */
export async function sweepStalledRuntimeStops(
  now: number = Date.now()
): Promise<{ stopped: string[]; failed: string[] }> {
  const stopping = await db
    .select({
      id: provisionedRuntimes.id,
      provider: provisionedRuntimes.provider,
      externalId: provisionedRuntimes.externalId,
      updatedAt: provisionedRuntimes.updatedAt,
    })
    .from(provisionedRuntimes)
    .where(
      and(
        eq(provisionedRuntimes.status, "stopping"),
        isNotNull(provisionedRuntimes.externalId)
      )
    );

  const stopped: string[] = [];
  const failed: string[] = [];

  for (const row of stopping) {
    const provisioner = getProvisionerUnguarded(row.provider);
    const state = provisioner
      ? await probeState(provisioner, row.externalId!)
      : "unknown";

    if (state === "stopped") {
      if (await confirmStopped(row.id)) {
        stopped.push(row.id);
        console.log(`[runtime-sweeper] ${row.id} stopping → stopped (substrate confirmed)`);
      }
      continue;
    }

    const waited = now - row.updatedAt.getTime();
    if (waited < STOP_TIMEOUT_MS) continue;

    const why =
      state === "running"
        ? `the ${row.provider} substrate still reports it running — it may still be billing`
        : `the ${row.provider} substrate did not report its state` +
          (provisioner ? "" : " (no driver is registered to ask)");

    const flipped = await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason:
          `the stop was not confirmed within ${humanMs(STOP_TIMEOUT_MS)}: ${why}. ` +
          `Check the substrate before assuming this runtime has stopped costing money`,
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(provisionedRuntimes.id, row.id),
          eq(provisionedRuntimes.status, "stopping")
        )
      )
      .returning({ id: provisionedRuntimes.id });

    if (flipped.length > 0) {
      failed.push(row.id);
      console.log(`[runtime-sweeper] ${row.id} stopping → error (stop unconfirmed, ${state})`);
    }
  }

  return { stopped, failed };
}

// Re-export for convenience (routes use this)
export { enabledProviders, providerManifests };
