/**
 * Rotating runtimes ahead of their substrate's instance lifetime ceiling.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { getProvisionerUnguarded } from "../provisioner";
import { reprovisionRuntime } from "./reprovision";
import { humanMs } from "./rows";

/**
 * How long before a substrate's ceiling a runtime is rotated.
 *
 * Long enough for a full re-create and re-enrolment (a node enrols within
 * seconds of its container booting; START_TIMEOUT_MS allows two minutes) with
 * room for the next 15s tick to retry if the first attempt is refused, and short
 * enough that rotation stays a rare event rather than a routine tax on a
 * runtime's life — every rotation is a fresh rootfs and a re-enrolment.
 *
 * A ceiling shorter than this margin does NOT mean "always rotate": see
 * rotationMarginFor.
 */
export const ROTATION_MARGIN_MS = 30 * 60_000;

/**
 * The margin to apply to one substrate's ceiling.
 *
 * Straight subtraction breaks for any ceiling shorter than the margin: the
 * threshold goes negative, every instance is born past due, and the sweeper
 * re-creates it on every tick — a paid rotation loop with nobody in it. That is
 * not hypothetical. The Modal driver takes a MODAL_MAX_LIFETIME_MS override
 * whose stated purpose is verifying rotation in ten minutes rather than a day,
 * and ten minutes is a third of this margin.
 *
 * So the margin never exceeds half the ceiling: a short-lived substrate rotates
 * at the midpoint of its instance's life, which is the same shape of promise
 * (replace it with time to spare) at a smaller scale.
 */
function rotationMarginFor(ceilingMs: number): number {
  return Math.min(ROTATION_MARGIN_MS, ceilingMs / 2);
}

/**
 * Rotate runtimes the substrate is about to destroy for age.
 *
 * The third sweep on the same tick, and the same idea one step further out:
 * sweepStalledRuntimeStarts handles a runtime that never arrived,
 * sweepStalledRuntimeStops one that would not leave, and this one a runtime the
 * PLATFORM is about to kill while it is working perfectly.
 *
 * Modal is why it exists — a hard 24-hour sandbox lifetime, no warning
 * callback, no way to extend it and no way back afterwards, so an unrotated
 * Modal station simply dies once a day. Nothing here knows that, though: it is
 * written against `manifest.maxLifetimeMs`, the same number the driver hands its
 * substrate as the instance's own timeout, so a substrate with no ceiling is
 * skipped entirely and one added tomorrow is covered without an edit here.
 *
 * Deliberately narrow. Each of these is a refusal to do something expensive:
 *   - Only `online` and `starting`. A `stopped` or `asleep` runtime must NEVER
 *     be rotated: re-creating one starts an instance nobody asked for that bills
 *     wall-clock until a human notices, and age alone would always say it is
 *     due, because a stopped runtime only gets older. `stopping` is an operator
 *     mid-stop and `error`/`destroyed` already need a human; none of them is
 *     improved by a new instance appearing on the meter.
 *   - Only rows with an externalId and an externalStartedAt. Without the second
 *     there is no age to judge, and both ways of guessing are wrong in the same
 *     direction: created_at rotates every pre-existing row immediately, and
 *     treating null as zero does too.
 *   - AGE ONLY. The substrate is never asked whether the instance is alive. A
 *     sandbox that died in its first minute will die the same way again, and
 *     re-creating it would rebuild it every fifteen seconds, billing each
 *     attempt, with nobody watching. The node going offline already surfaces
 *     that, and Start is one click for the human who looks.
 *   - Every write is a compare-and-set on the status that was read, so an
 *     operator stopping a runtime mid-sweep wins, and two overlapping ticks
 *     rotate once — two live instances on one anchor is the corruption case.
 *
 * @param now injectable clock for tests.
 * @returns the ids actually rotated.
 */
export async function sweepExpiringRuntimes(
  now: number = Date.now()
): Promise<string[]> {
  const live = await db
    .select()
    .from(provisionedRuntimes)
    .where(
      and(
        inArray(provisionedRuntimes.status, ["online", "starting"]),
        isNotNull(provisionedRuntimes.externalId),
        isNotNull(provisionedRuntimes.externalStartedAt)
      )
    );

  const rotated: string[] = [];

  for (const row of live) {
    const provisioner = getProvisionerUnguarded(row.provider);
    const ceiling = provisioner?.manifest.maxLifetimeMs ?? null;
    // No ceiling declared (docker, cloudflare), no registered driver to ask, or
    // a nonsense zero: nothing here destroys an instance for age, so rotating
    // one would throw away a working workspace to solve a problem that
    // substrate does not have.
    if (!ceiling || ceiling <= 0) continue;

    const age = now - row.externalStartedAt!.getTime();
    if (age < ceiling - rotationMarginFor(ceiling)) continue;

    const reason =
      `re-created before this substrate's ${humanMs(ceiling)} instance lifetime ` +
      `ceiling destroyed it` +
      (provisioner!.manifest.workspaceStorage === "rootfs"
        ? " — the instance's disk does not survive, so check the workspace"
        : " — the workspace is anchored outside the instance and carries over");

    // Claim the row first, and claim it on the status we read. The status write
    // IS the lock: a concurrent stop, or a second tick that overlaps this one,
    // finds the row already moved and leaves it alone.
    const claimed = await db
      .update(provisionedRuntimes)
      .set({ status: "provisioning", statusReason: reason, updatedAt: new Date(now) })
      .where(
        and(
          eq(provisionedRuntimes.id, row.id),
          eq(provisionedRuntimes.status, row.status)
        )
      )
      .returning({ id: provisionedRuntimes.id });
    if (claimed.length === 0) continue;

    try {
      await reprovisionRuntime(row, reason);
      rotated.push(row.id);
      console.log(
        `[runtime-sweeper] ${row.id} rotated ahead of the ${humanMs(ceiling)} ${row.provider} ceiling`
      );
    } catch (err) {
      // The platform is going to destroy this instance within the margin and the
      // hub could not replace it. Leaving it `online` would be the console
      // asserting health right up to the moment it vanishes.
      await db
        .update(provisionedRuntimes)
        .set({
          status: "error",
          statusReason:
            `could not re-create this runtime before its ${humanMs(ceiling)} ` +
            `lifetime ceiling: ${(err as Error).message}`,
          updatedAt: new Date(now),
        })
        .where(eq(provisionedRuntimes.id, row.id));
      console.error(
        `[runtime-sweeper] ${row.id} rotation failed: ${(err as Error).message}`
      );
    }
  }

  return rotated;
}
