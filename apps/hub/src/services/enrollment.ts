import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db/drizzle";
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
 * Enroll a node using a valid, unused enrollment token.
 * Returns the node's persistent credentials (nodeId + nodeSecret).
 * Throws if the token is invalid, expired, or already used.
 */
export async function enrollNode(
  token: string,
  hostInfo: HostInfo
): Promise<EnrollResponse> {
  const hash = await sha256(token);

  // Atomically consume the token: mark usedAt only if the token exists,
  // is unused, and has not expired. This single UPDATE eliminates the
  // TOCTOU race where two concurrent requests could both pass a SELECT
  // guard before either writes usedAt.
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
      .set({ nodeId, status: "online", updatedAt: new Date() })
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
