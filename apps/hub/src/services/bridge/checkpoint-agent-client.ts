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
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile, type CheckpointRefusalReason } from "./checkpoint-profile";
import { SuperpipelineClient, type Fetcher } from "./superpipeline";
import { deploymentSuperpipelineAudience } from "./credential-audience";

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

/**
 * The first pin the roster row's plane credential source breaks. A token row (no credential
 * source) or one the contract cannot parse is `credential.missing`. The audience must be this
 * deployment's configured SuperPipeline audience (`deploymentAudience`, null when unconfigured)
 * and the profile's, so a profile cannot select another plane. Exported for tests.
 */
export function credentialRefusal(profile: CheckpointProfile, source: BridgeCredentialSource | undefined,
  deploymentAudience: string | null): CheckpointRefusalReason | undefined {
  if (!source) return "credential.missing";
  if (source.principalId !== profile.occupantPrincipalId) return "credential.principal";
  if (source.organizationId !== profile.organizationId) return "credential.organization";
  if (!deploymentAudience || source.audience !== deploymentAudience || source.audience !== profile.sourceAudience)
    return "credential.audience";
  return undefined;
}

export async function checkpointAgentClient(configuration: CheckpointProfile): Promise<SuperpipelineClient> {
  const profile = parseCheckpointProfile(configuration);
  const initial = await readCheckpointAuthority(profile);
  const [row] = await db.select({ source: bridgeAgents.credentialSource }).from(bridgeAgents).where(and(
    eq(bridgeAgents.tenantId, profile.target.tenant_id), eq(bridgeAgents.key, profile.agentKey), eq(bridgeAgents.enabled, true)));
  const source = BridgeCredentialSource.safeParse(row?.source).data;
  const refusal = credentialRefusal(profile, source, deploymentSuperpipelineAudience());
  if (refusal || !source) throw new CheckpointRefused("authority", refusal ?? "credential.missing");
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
