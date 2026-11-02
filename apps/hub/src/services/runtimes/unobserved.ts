/**
 * The runtime nobody asked about (#347): probing the runtimes whose node has been unseen.
 */

import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { provisionedRuntimes, nodes } from "../../db/schema/nodes";
import { getProvisionerUnguarded } from "../provisioner";
import type { RuntimeProvisioner } from "../provisioner";
import { probeState } from "./probe";
import { humanMs } from "./rows";

/**
 * How long a node must have been unseen before its runtime is probed.
 *
 * The node sweeper already expires a node after 45s of silence, and most of
 * those are nothing: a hub restart, a redeploy, a flaky minute of network.
 * Probing every one would turn a substrate's API into a heartbeat and bill for
 * the privilege. Ten minutes is long past any of that and still far short of the
 * two days `cf-opencode` spent claiming to be online.
 */
export const UNOBSERVED_GRACE_MS = 10 * 60_000;

/**
 * Reconcile runtimes whose container stopped without anyone being told.
 *
 * The hub learns that a Cloudflare container stopped by being *told*
 * (`onActivityExpired` → `notifyHub`). That covers exactly one path: the idle
 * one, and only for sandboxes whose stored env carries the callback token. A
 * container that crashes, is evicted, is restarted by the platform, or predates
 * the callback feature says nothing at all — and until this sweep, nothing
 * asked. `cf-opencode` read `online` for two days with its container stopped.
 *
 * The rule this obeys is unchanged and load-bearing: **the absence of a node is
 * not evidence of a stop**, because nodes drop off the network while their
 * container runs and bills. What changes is the response to that absence. It was
 * "write nothing", which leaves a stale claim standing forever; it is now "go
 * and get evidence" — the drivers have a `status()` that answers, and a claim
 * the hub can check but does not is a claim it should not be making.
 *
 * Nothing here manufactures a state. A substrate that will not answer leaves the
 * status alone and gets a `statusReason` saying so, because "online, unverified"
 * and "online" are different facts and an operator is entitled to know which one
 * they are reading.
 */
export async function sweepUnobservedRuntimes(
  now: number = Date.now()
): Promise<{ reconciled: string[]; unverified: string[] }> {
  const cutoff = new Date(now - UNOBSERVED_GRACE_MS);

  const candidates = await db
    .select({
      id: provisionedRuntimes.id,
      provider: provisionedRuntimes.provider,
      externalId: provisionedRuntimes.externalId,
    })
    .from(provisionedRuntimes)
    .innerJoin(nodes, eq(nodes.id, provisionedRuntimes.nodeId))
    .where(
      and(
        eq(provisionedRuntimes.status, "online"),
        isNotNull(provisionedRuntimes.externalId),
        eq(nodes.status, "offline"),
        lt(nodes.lastSeenAt, cutoff)
      )
    );

  const reconciled: string[] = [];
  const unverified: string[] = [];

  for (const row of candidates) {
    const provisioner = getProvisionerUnguarded(row.provider);
    const state = provisioner ? await probeState(provisioner, row.externalId!) : "unknown";

    if (state === "running") {
      // The case the evidence rule exists to protect: the node is unreachable
      // and the container is fine. Nothing to write.
      continue;
    }

    if (state === "stopped") {
      // `asleep` where a stop can be undone, `stopped` where it cannot. On
      // Cloudflare a stopped container wakes with the same node id and its
      // workspace restored from R2, and telling an operator "stopped" for that
      // reads as "gone" — which is the sentence that gets a runtime destroyed
      // and its archive deleted with it.
      if (await markConfirmedDown(row, provisioner, now)) reconciled.push(row.id);
      continue;
    }

    // `unknown`, or no driver, or no status() to call. Say what is not known
    // rather than inventing what is.
    if (await annotateUnverified(row, provisioner, now)) unverified.push(row.id);
  }

  return { reconciled, unverified };
}

type Candidate = { id: string; provider: string };

/**
 * The substrate confirms the container is down: `asleep` where the stop can be undone, `stopped`
 * where it cannot. Compare-and-set on `online`. True when this write landed.
 */
async function markConfirmedDown(
  row: Candidate,
  provisioner: RuntimeProvisioner | undefined,
  now: number
): Promise<boolean> {
  const resumable = provisioner?.manifest?.stopSemantics === "resumable";

  const flipped = await db
    .update(provisionedRuntimes)
    .set({
      status: resumable ? "asleep" : "stopped",
      statusReason: resumable
        ? `its node stopped reporting and the ${row.provider} substrate confirms the ` +
          `container is down — start it to wake it, do not reprovision (that discards ` +
          `the workspace archive)`
        : null,
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(provisionedRuntimes.id, row.id),
        // Guarded: a node that reconnected mid-sweep has already written a
        // truer answer than this probe's.
        eq(provisionedRuntimes.status, "online")
      )
    )
    .returning({ id: provisionedRuntimes.id });

  if (flipped.length > 0) {
    console.log(
      `[runtime-sweeper] ${row.id} online → ${resumable ? "asleep" : "stopped"} ` +
        `(${row.provider} confirmed the container is down)`
    );
  }
  return flipped.length > 0;
}

/** No answer to be had: say what is not known on an `online` row. True when this write landed. */
async function annotateUnverified(
  row: Candidate,
  provisioner: RuntimeProvisioner | undefined,
  now: number
): Promise<boolean> {
  const why = !provisioner
    ? `no driver is registered for ${row.provider} to ask`
    : !provisioner.status
      ? `the ${row.provider} driver cannot report container state`
      : `the ${row.provider} substrate did not answer`;

  const annotated = await db
    .update(provisionedRuntimes)
    .set({
      statusReason:
        `its node has been unseen for over ${humanMs(UNOBSERVED_GRACE_MS)} and ` +
        `${why} — this runtime may not exist, and may still be billing`,
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(provisionedRuntimes.id, row.id),
        eq(provisionedRuntimes.status, "online")
      )
    )
    .returning({ id: provisionedRuntimes.id });

  return annotated.length > 0;
}
