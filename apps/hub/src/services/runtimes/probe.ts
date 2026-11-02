/**
 * Asking a driver whether a container is running, and the one write that answer can justify on
 * a stop: `stopping` → `stopped`.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { provisionedRuntimes } from "../../db/schema/nodes";
import type { RuntimeProvisioner, RuntimeState } from "../provisioner";

/**
 * Ask a driver whether a container is running, without ever letting the answer
 * (or the lack of one) break the caller.
 *
 * A probe that throws is not evidence of anything, so it degrades to `unknown`
 * — which is the honest answer and the one the callers are written to handle.
 * This is deliberately NOT a failure path: a broken probe must not turn a stop
 * that worked into a 502, and must not be mistaken for confirmation either.
 */
export async function probeState(
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
 * Compare-and-set `stopping` → `stopped`.
 *
 * Guarded on the status we read so evidence still beats us: a node that enrols
 * mid-flight has already written `online`, and this must not stomp it.
 */
export async function confirmStopped(id: string): Promise<boolean> {
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
