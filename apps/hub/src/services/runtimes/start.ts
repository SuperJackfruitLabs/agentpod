/**
 * Starting a runtime, completing a start on the evidence of its node, and expiring the starts
 * that never came back. `online` is written here only where a node is observed.
 */

import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { tenantScope } from "../../db/tenant-scope";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { getProvisionerUnguarded, wasAlreadyInTargetState } from "../provisioner";
import { reprovisionRuntime } from "./reprovision";
import { humanMs } from "./rows";
import type { RuntimeScope } from "./rows";

/**
 * Start (or wake) a runtime.
 *
 * Two shapes, chosen by the driver's `stopSemantics`:
 *   - `resumable` (docker, cloudflare) — start the instance that is already
 *     there. Throws 400 if such a driver has no start() support.
 *   - `terminal` (modal) — there is nothing to start, so this re-creates the
 *     instance against the same anchor. See reprovisionRuntime.
 *
 * Leaves the runtime `starting`, never `online`: see the comment on the write.
 * A wake takes the same path, so an asleep runtime goes asleep → starting →
 * online (or → error, if the substrate says yes and nothing comes back).
 */
export async function startRuntime(scope: RuntimeScope, id: string): Promise<void> {
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
  // A driver whose stop is terminal has no start to call — Modal's terminate is
  // irreversible — so a restart on such a substrate IS a create, against the
  // anchor that carries the workspace. Manifest-driven rather than
  // provider-specific: any future terminal substrate gets this for free, and the
  // console's Start button needs no idea which kind it is talking to.
  //
  // The condition is the MANIFEST, not the missing method. A resumable driver
  // that happens to lack start() keeps its 400: its instance survives a stop, so
  // destroying it and building a replacement would throw away the disk the
  // declaration promises. Conformance rule 3 now refuses such a driver outright.
  if (provisioner.manifest.stopSemantics === "terminal") {
    await reprovisionRuntime(
      row,
      "re-created: this substrate has no start, so a start is a new instance"
    );
    return;
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

  const outcome = await provisioner.start(row.externalId);

  // The substrate says there was nothing to do: this instance is ALREADY
  // running. That is the state the caller asked for, so the request succeeded —
  // and it succeeded without changing anything, so nothing is written.
  //
  // Returning here rather than falling through to `starting` is the point.
  // `online` is written by enrolment alone, and the row that says it is the only
  // record that a node ever arrived; overwriting it with `starting` on a
  // redundant click would hand a live runtime to sweepStalledRuntimeStarts,
  // which flips anything still `starting` after two minutes to `error`. A
  // double-click would take a healthy station down.
  //
  // Reconciling a row that DISAGREES with the substrate — `stopped` on the row,
  // container running — is a different job and deliberately not done here: this
  // path has one piece of evidence, about one instance, gathered as a side
  // effect of a button press. status() and its sweepers are what the hub uses to
  // write state from evidence, and they run on every tick rather than on a click.
  if (wasAlreadyInTargetState(outcome)) {
    console.log(
      `[runtimes] ${id}: start was a no-op — ${row.provider} reports it already running`
    );
    return;
  }

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

/**
 * Complete a pending start on the evidence that the runtime's node is here.
 *
 * Enrolment was the ONLY writer of `online`, which silently assumed every
 * container enrols on every boot. Docker does, and Modal's stop is terminal so
 * its start is a re-provision that enrols too — but a substrate that RESUMES an
 * instance (Fly, and any driver with a real `start()` whose agent keeps its
 * credential on a persistent disk) brings back an agent that logs
 * `already enrolled: node_…` and merely reconnects. Enrolment never ran, so the
 * runtime sat in `starting` until sweepStalledRuntimeStarts called it an error
 * — while its node was online and heartbeating (#281).
 *
 * A node the hub already knows arriving on the gateway is the same evidence
 * enrolment carries: a node for this runtime exists, right now. It is NOT the
 * widening #254 forbade — that was a driver's `start()` promise resolving,
 * which says only that the substrate accepted a request. Never write `online`
 * from a driver call returning; only from a node being there.
 *
 * Deliberately narrow, and this is the dangerous half:
 *   - Only `starting` is completed. Nodes reconnect after ordinary network
 *     blips, and a `stopped`, `asleep`, `error` or `destroyed` runtime quietly
 *     reading `online` would misreport a substrate that is still billing or
 *     still down. The compare-and-set is in the WHERE clause, so a concurrent
 *     stop cannot be overwritten by a racing reconnect.
 *   - Scoped to this node's own runtime, by node_id.
 *   - `statusReason` is cleared for the same reason enrolment clears it: any
 *     earlier "never came back" note has just been retired.
 *
 * Never throws — it is called from the gateway, where nothing may break a node
 * connection. Returns the ids it flipped (empty when there was nothing to do).
 */
export async function completeRuntimeStartForNode(
  nodeId: string
): Promise<string[]> {
  try {
    const flipped = await db
      .update(provisionedRuntimes)
      .set({ status: "online", statusReason: null, updatedAt: new Date() })
      .where(
        and(
          eq(provisionedRuntimes.nodeId, nodeId),
          eq(provisionedRuntimes.status, "starting")
        )
      )
      .returning({ id: provisionedRuntimes.id });

    for (const row of flipped) {
      console.log(
        `[runtimes] ${row.id} starting → online (node ${nodeId} reconnected)`
      );
    }
    return flipped.map((r) => r.id);
  } catch (err) {
    console.warn(
      `[runtimes] could not complete start for node ${nodeId}: ${(err as Error).message}`
    );
    return [];
  }
}

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
