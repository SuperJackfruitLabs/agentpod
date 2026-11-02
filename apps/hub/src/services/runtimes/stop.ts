/**
 * Stopping a runtime, and reconciling the ones left `stopping`. `stopped` is written only on the
 * substrate's own answer.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { tenantScope } from "../../db/tenant-scope";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { getProvisionerUnguarded } from "../provisioner";
import { confirmStopped, probeState } from "./probe";
import { humanMs } from "./rows";
import type { RuntimeScope } from "./rows";

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
export async function stopRuntime(scope: RuntimeScope, id: string): Promise<void> {
  const [row] = await db
    .select()
    .from(provisionedRuntimes)
    .where(tenantScope(provisionedRuntimes, scope.tenantId, eq(provisionedRuntimes.id, id)));

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
