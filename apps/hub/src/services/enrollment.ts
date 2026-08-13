import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/drizzle";
import { resolveTenantForUser } from "../auth/tenant";
import { nodes, enrollmentTokens, provisionedRuntimes } from "../db/schema/nodes";
import type { HostInfo, EnrollResponse } from "@agentpod/contract";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a prefixed ID: e.g. "node_a1b2c3d4e5f6..." */
const prefixedId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** SHA-256 hex digest of a string */
const sha256 = async (s: string): Promise<string> =>
  Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  ).toString("hex");

// ─────────────────────────────────────────────────────────────────────────────
// Service functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifetime for a runtime-bound token: ten years, i.e. "as long as the runtime".
 *
 * A runtime-bound token is re-presented on every container restart, which on an
 * ephemeral-disk substrate is routine and may happen long after provisioning.
 * An expiry here would mean a runtime that silently stops being able to come
 * back — the exact failure this work exists to remove.
 *
 * It is revoked by destroying the runtime, not by waiting.
 */
export const RUNTIME_TOKEN_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Mint an enrollment token for a user.
 * The raw token is returned once; only its SHA-256 hash is persisted.
 *
 * @param userId - The user to mint the token for.
 * @param opts   - Optional settings:
 *   - ttlMs              — token lifetime in ms. Defaults to 1 hour, or
 *                          RUNTIME_TOKEN_TTL_MS when provisionedRuntimeId is set.
 *   - provisionedRuntimeId — when set, the token is linked to that runtime so
 *                            enrollNode can flip it online automatically.
 */
export async function mintEnrollmentToken(
  userId: string,
  opts?: { ttlMs?: number; provisionedRuntimeId?: string }
): Promise<{ token: string; expiresAt: Date }> {
  const ttlMs =
    opts?.ttlMs ?? (opts?.provisionedRuntimeId ? RUNTIME_TOKEN_TTL_MS : 60 * 60 * 1000);
  const token =
    prefixedId("enr") + crypto.randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(enrollmentTokens).values({
    id: prefixedId("etk"),
    // A root row: its tenant comes from the principal minting it. Everything
    // enrolled with this token inherits the tenant from here.
    tenantId: await resolveTenantForUser(userId),
    userId,
    tokenHash: await sha256(token),
    expiresAt,
    ...(opts?.provisionedRuntimeId
      ? { provisionedRuntimeId: opts.provisionedRuntimeId }
      : {}),
  });

  return { token, expiresAt };
}

/**
 * Enroll a node using a valid enrollment token.
 *
 * Returns the node's persistent credentials (nodeId + nodeSecret).
 *
 * Two paths:
 *   - **Runtime-bound token whose runtime already has a node** — returns that
 *     node with a rotated secret. This is what lets a runtime on an
 *     ephemeral-disk substrate survive a restart instead of orphaning itself.
 *   - **Everything else** — consumes the token atomically and mints a new node.
 *     Unbound tokens remain strictly one-time.
 *
 * Throws if the token is invalid, expired, already used (unbound only), or
 * bound to a runtime that no longer exists.
 */
export async function enrollNode(
  token: string,
  hostInfo: HostInfo
): Promise<EnrollResponse> {
  const hash = await sha256(token);

  // ── Runtime-bound re-enrolment ────────────────────────────────────────────
  //
  // A provisioned runtime on an ephemeral-disk substrate loses its config on
  // every restart and re-presents this token. Minting a new node there would
  // orphan the runtime's stations, capabilities and history — so if the runtime
  // already has a node, we resume it.
  //
  // Deliberately does NOT gate on usedAt: that gate is what makes an unbound
  // token one-time, and re-presentation is the whole point here.
  const [bound] = await db
    .select()
    .from(enrollmentTokens)
    .where(
      and(
        eq(enrollmentTokens.tokenHash, hash),
        gt(enrollmentTokens.expiresAt, new Date())
      )
    );

  if (bound?.provisionedRuntimeId) {
    const [runtime] = await db
      .select()
      .from(provisionedRuntimes)
      .where(eq(provisionedRuntimes.id, bound.provisionedRuntimeId));

    // The runtime was destroyed. Its identity is gone on purpose, and this
    // token must not degrade into an unbound one that mints something new.
    if (!runtime) {
      throw new Error("invalid or expired enrollment token");
    }

    if (runtime.nodeId) {
      // Rotate the secret. The container stores nothing durably, so a fresh
      // secret costs nothing and retires any that leaked from a previous
      // incarnation.
      const nodeSecret =
        crypto.randomUUID().replace(/-/g, "") +
        crypto.randomUUID().replace(/-/g, "");

      // Concurrent re-enrolments converge here rather than creating a second
      // node: both target the same row, and the loser's secret is simply
      // superseded — which the node-agent handles by reconnecting.
      const updated = await db
        .update(nodes)
        .set({
          secretHash: await Bun.password.hash(nodeSecret),
          hostname: hostInfo.hostname,
          os: hostInfo.os,
          arch: hostInfo.arch,
          cpuCount: hostInfo.cpuCount,
        })
        .where(eq(nodes.id, runtime.nodeId))
        .returning();

      // If the node row is gone the runtime points at nothing; fall through and
      // treat it as a first boot rather than failing — the runtime is real and
      // wants a node.
      if (updated.length > 0) {
        await db
          .update(provisionedRuntimes)
          // A node is here: this is the evidence "online" is a claim about.
          // Clearing statusReason retires any earlier "never came back" note —
          // it just did.
          .set({ status: "online", statusReason: null, updatedAt: new Date() })
          .where(eq(provisionedRuntimes.id, runtime.id));

        return { nodeId: runtime.nodeId, nodeSecret };
      }
    }
  }

  // ── First enrolment ───────────────────────────────────────────────────────
  //
  // Atomically consume the token: mark usedAt only if the token exists, is
  // unused, and has not expired. This single UPDATE eliminates the TOCTOU race
  // where two concurrent requests could both pass a SELECT guard before either
  // writes usedAt.
  const [row] = await db
    .update(enrollmentTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(enrollmentTokens.tokenHash, hash),
        isNull(enrollmentTokens.usedAt),
        gt(enrollmentTokens.expiresAt, new Date()),
      )
    )
    .returning();

  if (!row) {
    throw new Error("invalid or expired enrollment token");
  }

  // Generate node identity
  const nodeId = prefixedId("node");
  const nodeSecret =
    crypto.randomUUID().replace(/-/g, "") +
    crypto.randomUUID().replace(/-/g, "");

  await db.insert(nodes).values({
    id: nodeId,
    // The node inherits the TOKEN's tenant, not a freshly resolved one. The
    // token is the authority that admitted this node to the fleet, so a node
    // cannot land in a tenant other than the one whose token enrolled it —
    // which stays true once tokens can be minted for more than one.
    tenantId: row.tenantId,
    userId: row.userId,
    name: hostInfo.hostname,
    hostname: hostInfo.hostname,
    os: hostInfo.os,
    arch: hostInfo.arch,
    cpuCount: hostInfo.cpuCount,
    secretHash: await Bun.password.hash(nodeSecret),
    status: "offline",
  });

  // If the token was minted with a provisioned runtime, link the node back to it
  // and flip its status to "online" so the runtime record reflects the enrolment.
  if (row.provisionedRuntimeId) {
    await db
      .update(provisionedRuntimes)
      .set({ nodeId, status: "online", statusReason: null, updatedAt: new Date() })
      .where(eq(provisionedRuntimes.id, row.provisionedRuntimeId));
  }

  return { nodeId, nodeSecret };
}

/**
 * Verify a node's long-term credential (used by the node agent on reconnect).
 */
export async function verifyNodeCredential(
  nodeId: string,
  nodeSecret: string
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, nodeId));

  if (!row) return false;
  return Bun.password.verify(nodeSecret, row.secretHash);
}
