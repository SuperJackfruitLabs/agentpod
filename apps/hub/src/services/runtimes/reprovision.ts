/**
 * Re-creating a runtime's instance against the same anchor: what a start is on a substrate whose
 * stop is terminal, and what the rotation sweep does ahead of an instance lifetime ceiling.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { mintEnrollmentToken } from "../nodes";
import { getProvisionerUnguarded } from "../provisioner";
import { imageForHarness } from "./image";
import type { RuntimeRow } from "./rows";

/**
 * The hub URL a provisioned container should dial.
 *
 * Request-scoped for createRuntime, which can take the origin of the call that
 * asked for the runtime. A re-create cannot: it runs on a rotation timer with no
 * request in sight, so there it has to come from configuration. Throwing here is
 * the point — the alternative is a container handed a hub URL of "" or
 * "localhost", which boots, fails to enrol, and reports nothing but a runtime
 * that never came back.
 */
function provisioningHubUrl(): string {
  const url = process.env.PROVISIONING_HUB_URL;
  if (!url) {
    throw Object.assign(
      new Error(
        "PROVISIONING_HUB_URL is not set, so a runtime cannot be re-created — " +
          "the new container would have no hub to enrol against"
      ),
      { status: 502 }
    );
  }
  return url;
}

/**
 * Re-create a runtime's instance on a substrate whose stop is terminal.
 *
 * This is what "start" means when there is no start verb. Modal's terminate
 * cannot be undone and every restart is a new sandbox with a new id and a fresh
 * rootfs — so the thing that persists is the driver's anchor, and a driver
 * anchors by `spec.runtimeId`. Provisioning again with the SAME runtimeId
 * therefore re-attaches the same workspace. A fresh id would look like it
 * worked: a new sandbox, a new Volume, an empty workspace, and the old Volume
 * orphaned — still billed, still holding the only copy of the station's work.
 *
 * Three things happen alongside the create, and each is easy to forget:
 *
 *  - The old instance is terminated FIRST, best effort. Leaving it behind is a
 *    sandbox nobody is watching and everybody is paying for, and two live
 *    sandboxes on one Volume is the corruption case. Best effort, because the
 *    old one is very often already gone (that is the 24h ceiling doing its job)
 *    and refusing to create a replacement because the corpse would not die again
 *    helps nobody — but a failure is recorded in statusReason, where the console
 *    shows it, rather than left to a log nobody reads.
 *  - A FRESH enrolment token is minted. The hub stores only a hash, so it cannot
 *    re-present the original; a new runtime-bound token is durable by default
 *    (RUNTIME_TOKEN_TTL_MS) and enrollNode resumes the existing node with a
 *    rotated secret rather than orphaning it.
 *  - `externalStartedAt` is rewritten. The new sandbox has its own ceiling, and
 *    an instance clock left at the old value would have the rotation sweep find
 *    a freshly created sandbox already expired and replace it again on the very
 *    next tick, for ever.
 *
 * Leaves the runtime `starting` — never `online`. The substrate accepting a
 * create is not a node existing, and sweepStalledRuntimeStarts walks it back to
 * `error` if none arrives.
 */
export async function reprovisionRuntime(
  row: RuntimeRow,
  reason: string
): Promise<void> {
  const provisioner = getProvisionerUnguarded(row.provider);
  if (!provisioner) {
    throw Object.assign(new Error(`provider not available: ${row.provider}`), {
      status: 502,
    });
  }

  const hubUrl = provisioningHubUrl();

  let terminateWarning: string | null = null;
  if (row.externalId && provisioner.stop) {
    try {
      await provisioner.stop(row.externalId);
    } catch (err) {
      terminateWarning =
        `the previous instance (${row.externalId}) could not be terminated: ` +
        `${(err as Error).message} — check the substrate, it may still be billing`;
      console.warn(`[runtimes] ${row.id}: ${terminateWarning}`);
    }
  }

  // The runtime's own tenant: a replacement instance re-enrols into the fleet it was created in.
  const { token } = await mintEnrollmentToken(row.userId, row.tenantId, {
    provisionedRuntimeId: row.id,
  });

  try {
    const { externalId, runtime } = await provisioner.provision({
      runtimeId: row.id,
      name: row.name,
      resourceTier: row.resourceTier as "small" | "medium" | "large",
      hubUrl,
      enrollToken: token,
      // Provider-scoped: a re-provision is the path a rotating substrate takes
      // every 24 hours, so it must resolve the same reference the original
      // create did — and Modal's reference is not Docker's.
      image: imageForHarness(row.harness ?? "none", row.provider),
    });

    await db
      .update(provisionedRuntimes)
      .set({
        externalId,
        runtime: runtime ?? row.runtime ?? null,
        externalStartedAt: new Date(),
        status: "starting",
        statusReason: terminateWarning ? `${reason}. ${terminateWarning}` : reason,
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, row.id));
  } catch (err) {
    // A re-create is a create, and a create can be refused. Leaving the row
    // `starting` would hand the operator a spinner for something that has
    // already failed, and the stalled-start sweeper would eventually blame the
    // wrong thing ("no node enrolled") two minutes later.
    await db
      .update(provisionedRuntimes)
      .set({
        status: "error",
        statusReason:
          `the ${row.provider} driver failed to re-create it: ${(err as Error).message}` +
          (terminateWarning ? `. ${terminateWarning}` : ""),
        updatedAt: new Date(),
      })
      .where(eq(provisionedRuntimes.id, row.id));
    throw Object.assign(err as Error, { status: 502 });
  }
}
