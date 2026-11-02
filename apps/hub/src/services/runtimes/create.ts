/**
 * Creating a runtime: the guards that refuse before anything is written, the row, its enrolment
 * token, the driver's provision().
 */

import { eq } from "drizzle-orm";
import { HARNESS_MIN_MEMORY_MB, tierFitsHarness } from "@agentpod/contract";
import type { ProvisionedRuntime, ResourceTier } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { provisionedRuntimes } from "../../db/schema/nodes";
import { mintEnrollmentToken } from "../nodes";
import { getProvisioner, getProvisionerUnguarded, isProviderEnabled } from "../provisioner";
import { imageForHarness } from "./image";
import { prefixedId, toContract } from "./rows";

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * The two refusals a create makes before anything is written (400): a provider this deployment
 * has not enabled, and a harness the chosen tier cannot hold.
 */
function refuseUnusableRequest(provider: string, harness: string, resourceTier: ResourceTier): void {
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
}

/** A create that failed after its row exists: the row says so, with the reason. */
async function markCreateFailed(id: string, statusReason: string): Promise<void> {
  await db
    .update(provisionedRuntimes)
    .set({
      status: "error",
      statusReason,
      updatedAt: new Date(),
    })
    .where(eq(provisionedRuntimes.id, id));
}

/** The substrate accepted the instance: its id, its container runtime, and its clock. */
async function recordProvisioned(id: string, externalId: string, runtime: string | undefined): Promise<void> {
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
}

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
  /** The creating request's tenant (W5); the runtime, its token and its node live in it. */
  tenantId: string,
  req: { provider: string; name: string; resourceTier: string; harness?: string },
  hubUrl: string
): Promise<ProvisionedRuntime> {
  const provider = req.provider;
  const harness = req.harness ?? "none";
  const resourceTier = (req.resourceTier ?? "small") as ResourceTier;

  refuseUnusableRequest(provider, harness, resourceTier);

  const id = prefixedId("rt");
  const now = new Date();

  await db.insert(provisionedRuntimes).values({
    id,
    tenantId,
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
    const result = await mintEnrollmentToken(userId, tenantId, {
      provisionedRuntimeId: id,
    });
    enrollToken = result.token;
  } catch (err) {
    await markCreateFailed(id, `could not mint an enrolment token: ${(err as Error).message}`);
    throw Object.assign(err as Error, { status: 502 });
  }

  let provisioner: ReturnType<typeof getProvisioner>;
  try {
    provisioner = getProvisioner(provider);
  } catch (err) {
    // Driver not registered (env flag on but no driver wired) → 400
    await markCreateFailed(id, (err as Error).message);
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

    await recordProvisioned(id, externalId, runtime);

    const [row] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, id));

    return toContract(row!);
  } catch (err) {
    await markCreateFailed(id, `the ${provider} driver failed to provision it: ${(err as Error).message}`);
    // Surface as 502 — the driver (external system) failed
    throw Object.assign(err as Error, { status: 502 });
  }
}
