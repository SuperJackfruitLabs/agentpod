/**
 * Fleet-era runtime provisioning service (P4 Task 8).
 *
 * Orchestrates the full lifecycle of a provisioned runtime:
 *   create → mint-token → provision-driver → persist externalId
 *   destroy → driver.destroy → mark destroyed
 *   start / stop → driver.start/stop (guard on capability)
 *
 * "start" is not one verb, though. On a substrate whose stop is terminal there
 * is no start to call, and the honest restart is a create against the anchor
 * that carries the workspace — so startRuntime branches on the driver's
 * declared `stopSemantics` and reprovisionRuntime handles that half.
 *
 * Status honesty: `online` means "a node for this runtime is connected", so it
 * is written only where a node is observed — enrolment (enrollment.ts) and, for
 * a resumed instance whose agent keeps its credential and never re-enrols, the
 * gateway calling completeRuntimeStartForNode() below (#281). Everything here
 * can say at most "the substrate accepted my request" — hence `provisioning` /
 * `starting`, and sweepStalledRuntimeStarts() to expire the ones that never
 * come back.
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
import { resolveTenantForUser } from "../auth/tenant";
import { tenantScope } from "../db/tenant-scope";
import { provisionedRuntimes, nodes } from "../db/schema/nodes";
import { mintEnrollmentToken } from "./enrollment";
import {
  getProvisioner,
  getProvisionerUnguarded,
  enabledProviders,
  providerManifests,
  isProviderEnabled,
} from "./provisioner/registry";
import { imageForHarness } from "./runtimes-image";
import { HARNESS_MIN_MEMORY_MB, tierFitsHarness } from "@agentpod/contract";
import type { ProvisionedRuntime, ResourceTier } from "@agentpod/contract";
import type { RuntimeProvisioner, RuntimeState } from "./provisioner/types";
import { wasAlreadyInTargetState } from "./provisioner/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const prefixedId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/**
 * Image resolution now lives in ./runtimes-image.ts, so that boot-time config
 * validation can ask the same question without importing this module and, with
 * it, the database layer. Re-exported because every caller and both test files
 * reach it through here.
 */
export { imageForHarness };

export type RuntimeRow = typeof provisionedRuntimes.$inferSelect;

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

  const harness = req.harness ?? "none";
  const resourceTier = (req.resourceTier ?? "small") as ResourceTier;

  // Guard — 400 before anything is written, for the same reason as the one
  // above: a combination that cannot work must be refused, not created.
  //
  // The console filters these out of its picker, and this is deliberately not
  // the only place they are refused (issue #279). The API is callable directly,
  // consoles deploy separately from hubs, and the failure this prevents is the
  // worst-shaped one we have shipped: provisioning, volume mount, enrolment and
  // the first response ALL look healthy, and the machine then wedges partway
  // through the first chat turn, which the user meets as "couldn't reach the
  // hub". Refusing costs one request.
  //
  // Silent when the driver declares no memory for the tier: the manifest is
  // evidence-only, and an undeclared size may not become a refusal.
  const manifest = getProvisionerUnguarded(provider)?.manifest;
  const tierMemoryMb = manifest?.tierMemoryMb?.[resourceTier];
  if (!tierFitsHarness(harness, tierMemoryMb)) {
    const needed = HARNESS_MIN_MEMORY_MB[harness as keyof typeof HARNESS_MIN_MEMORY_MB];
    const roomier = (manifest?.supportedTiers ?? []).filter((tier) =>
      tierFitsHarness(harness, manifest?.tierMemoryMb?.[tier])
    );
    throw Object.assign(
      new Error(
        `harness "${harness}" needs ${needed} MB but the ${provider} "${resourceTier}" ` +
          `tier gives ${tierMemoryMb} MB. ` +
          (roomier.length > 0
            ? `Choose ${roomier.join(" or ")}.`
            : `No ${provider} tier is large enough for it.`)
      ),
      { status: 400 }
    );
  }

  const id = prefixedId("rt");
  const now = new Date();

  await db.insert(provisionedRuntimes).values({
    id,
    tenantId: await resolveTenantForUser(userId),
    userId,
    provider,
    status: "provisioning",
    name: req.name,
    resourceTier,
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
      resourceTier,
      hubUrl,
      enrollToken,
      image: imageForHarness(harness, provider),
    });

    await db
      .update(provisionedRuntimes)
      .set({
        externalId,
        runtime: runtime ?? null,
        // The instance clock starts where the instance does: the substrate has
        // just accepted this one. It is set HERE, beside the externalId, and
        // not at insert time, because until provision() resolves there is no
        // instance to date — a failed provision must leave this null.
        //
        // Every later write of externalId has to set this too. A substrate that
        // replaces the instance (Modal terminates a sandbox at its 24h ceiling
        // and the hub re-creates against the same volume) would otherwise keep
        // the age of the instance it replaced, and be rotated again on the very
        // next sweep — for ever.
        externalStartedAt: new Date(),
        updatedAt: new Date(),
      })
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
      tenantScope(
        provisionedRuntimes,
        await resolveTenantForUser(userId),
        eq(provisionedRuntimes.userId, userId),
        ne(provisionedRuntimes.status, "destroyed"),
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

  const { token } = await mintEnrollmentToken(row.userId, {
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

const humanMs = (ms: number) =>
  ms >= 3_600_000
    ? `${Math.round(ms / 3_600_000)}h`
    : ms >= 60_000
      ? `${Math.round(ms / 60_000)}m`
      : `${Math.round(ms / 1000)}s`;

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

// Re-export for convenience (routes use this)
export { enabledProviders, providerManifests };
