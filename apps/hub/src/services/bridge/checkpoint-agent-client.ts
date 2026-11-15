/** Dedicated claim authority does not depend on ACP health or a Salaam harness label. */
import { and, eq } from "drizzle-orm";
import { BridgeCredentialSource } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { bridgeAgents } from "../../db/schema/bridge";
import { orgPlaneClient } from "../../auth/org-plane/client";
import { orgPlane } from "../../auth/org-plane/config";
import { createPlaneVerifier } from "../../auth/org-plane/verify";
import { createBridgePlaneCredential } from "./plane-credential";
import { readCheckpointAuthority } from "./checkpoint-current";
import { canonicalCheckpoint, parseCheckpointContextJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { SuperpipelineClient, type Fetcher } from "./superpipeline";

const boundedFetch: Fetcher = async (url, init) => {
  try {
    const response = await fetch(url, { ...init, redirect: "error", credentials: "omit", headers: { ...init.headers, accept: "application/json", "accept-encoding": "identity" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { status: response.status, ok: false, json: async () => ({ error: "CHECKPOINT_REQUEST_REFUSED" }) };
    const reader = response.body?.getReader();
    if (!reader || response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")
      throw new CheckpointRefused("unavailable");
    const parts: Uint8Array[] = []; let count = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        count += chunk.value.byteLength;
        if (count > 262144) throw new CheckpointRefused("unavailable");
        parts.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const raw = new Uint8Array(count); let position = 0;
    for (const part of parts) { raw.set(part, position); position += part.byteLength; }
    const value = parseCheckpointContextJSON(raw);
    return { status: response.status, ok: true, json: async () => value };
  } catch { throw new CheckpointRefused("unavailable"); }
};

export async function checkpointAgentClient(configuration: CheckpointProfile): Promise<SuperpipelineClient> {
  const profile = parseCheckpointProfile(configuration);
  const initial = await readCheckpointAuthority(profile);
  const [row] = await db.select({ source: bridgeAgents.credentialSource }).from(bridgeAgents).where(and(
    eq(bridgeAgents.tenantId, profile.target.tenant_id), eq(bridgeAgents.key, profile.agentKey), eq(bridgeAgents.enabled, true)));
  const parsed = BridgeCredentialSource.safeParse(row?.source);
  if (!parsed.success || parsed.data.principalId !== profile.occupantPrincipalId ||
    parsed.data.organizationId !== profile.organizationId || parsed.data.audience !== profile.sourceAudience)
    throw new CheckpointRefused("authority");
  const source = parsed.data;
  const issuer = orgPlane();
  const verifier = createPlaneVerifier({ issuer: issuer.issuer, audience: source.audience, jwksUrl: issuer.jwksUrl });
  const snapshot = async () => {
    const current = await readCheckpointAuthority(profile);
    const [stored] = await db.select({ source: bridgeAgents.credentialSource }).from(bridgeAgents).where(and(
      eq(bridgeAgents.tenantId, profile.target.tenant_id), eq(bridgeAgents.key, profile.agentKey), eq(bridgeAgents.enabled, true)));
    if (canonicalCheckpoint(current) !== canonicalCheckpoint(initial) ||
      canonicalCheckpoint(stored?.source) !== canonicalCheckpoint(source)) throw new CheckpointRefused("stale");
    return { revision: initial.rosterRevision, principalId: current.principalId, org: current.organizationId,
      owner: current.ownerPrincipalId, enabled: true };
  };
  const selected = await snapshot();
  const credential = createBridgePlaneCredential(source, selected, { snapshot,
    exchange: (principal, audience) => orgPlaneClient().agentToken(principal, audience), verify: async (token) => {
      const claims = await verifier.verify(token);
      // The Node callback has a five-second whole-request deadline. Refuse a
      // token too near expiry to cover that short-lived decision.
      return claims && claims.exp * 1000 > Date.now() + 10_000 ? claims : null;
    } });
  return new SuperpipelineClient({ baseUrl: profile.sourceOrigin, boardId: profile.target.board_id,
    token: "", credential, fetch: boundedFetch });
}
