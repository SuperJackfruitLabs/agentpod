/** Dedicated claim authority does not depend on ACP health or a Salaam harness label. */
import { and, eq } from "drizzle-orm";
import { BridgeCredentialSource } from "@agentpod/contract";
import { db } from "../../db/drizzle";
import { bridgeAgents } from "../../db/schema/bridge";
import { orgPlaneClient } from "../../auth/org-plane/client";
import { orgPlane } from "../../auth/org-plane/config";
import { sharedPlaneVerifier } from "../../auth/org-plane/verify";
import { createBridgePlaneCredential } from "./plane-credential";
import { readCheckpointAuthority } from "./checkpoint-current";
import { canonicalCheckpoint, parseCheckpointContextJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile, type CheckpointRefusalReason } from "./checkpoint-profile";
import { SuperpipelineClient, type Fetcher } from "./superpipeline";
import { noteCheckpoint } from "./checkpoint-log";
import { deploymentSuperpipelineAudience } from "./credential-audience";

/** Which part of a bounded request failed, as a closed reason. Exported for tests. */
export function httpFailureReason(error: unknown): "http.timeout" | "http.network" | "http.encoding" | "http.size" | "http.body" {
  if (error instanceof CheckpointRefused && (error.reason === "http.encoding" || error.reason === "http.size")) return error.reason;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "http.timeout";
  if (error instanceof SyntaxError || error instanceof CheckpointRefused) return "http.body";
  return "http.network";
}

/** The request path only: no query, no host secrets. */
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return "unparsable"; } }; // silent-catch-ok: a label for the log line, never a decision

/**
 * The board's error codes a refusal may carry on this path: the ones that say the run ended or is
 * someone else's (checkpoint-run-ended.ts, and `lease_ended` on a held failure). Nothing else of
 * the board's error body is kept: no message, no other code. Exported for tests.
 */
export const BOARD_RUN_CODES: ReadonlySet<string> = new Set(["STALE_LEASE", "NOT_RUN_OWNER", "RUN_NOT_FOUND", "CARD_NOT_FOUND"]);

/** The error body a refusal is handed on as: the closed code alone, or the fixed refusal. Exported for tests. */
export function boardErrorBody(raw: string): { error: string | { code: string } } {
  let code: unknown;
  try { const parsed: unknown = JSON.parse(raw); code = Reflect.get(Object(Reflect.get(Object(parsed), "error")), "code"); }
  catch { code = undefined; } // silent-catch-ok: an unparsable error body carries no code; the status is logged by the caller
  return typeof code === "string" && BOARD_RUN_CODES.has(code) ? { error: { code } } : { error: "CHECKPOINT_REQUEST_REFUSED" };
}

/** At most 4 KiB of an error body; a longer or unreadable one carries no code. */
async function errorText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = []; let count = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      count += chunk.value.byteLength;
      if (count > 4096) return "";
      parts.push(chunk.value);
    }
  } catch { return ""; } // silent-catch-ok: an unreadable error body carries no code; its status is logged by the caller
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } // silent-catch-ok: releasing a reader already read or failed
  return Buffer.concat(parts).toString("utf8");
}

const boundedFetch: Fetcher = async (url, init) => {
  try {
    const response = await fetch(url, { ...init, redirect: "error", credentials: "omit", headers: { ...init.headers, accept: "application/json", "accept-encoding": "identity" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      // Only a closed code survives from the board's error body: before, the body was dropped whole,
      // so a STALE_LEASE or RUN_NOT_FOUND never reached the attempt and a run the board ended parked.
      const body = boardErrorBody(await errorText(response));
      noteCheckpoint("http", "http.status", { status: response.status, path: pathOf(url),
        ...(typeof body.error === "string" ? {} : { code: body.error.code }) });
      return { status: response.status, ok: false, json: async () => body };
    }
    const reader = response.body?.getReader();
    if (!reader || response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")
      throw new CheckpointRefused("unavailable", "http.encoding");
    const parts: Uint8Array[] = []; let count = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        count += chunk.value.byteLength;
        if (count > 262144) throw new CheckpointRefused("unavailable", "http.size");
        parts.push(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } // silent-catch-ok: releasing a reader already read or failed
    const raw = new Uint8Array(count); let position = 0;
    for (const part of parts) { raw.set(part, position); position += part.byteLength; }
    const value = parseCheckpointContextJSON(raw);
    return { status: response.status, ok: true, json: async () => value };
  } catch (error) {
    const reason = httpFailureReason(error);
    noteCheckpoint("http", reason, { path: pathOf(url) }, error);
    throw new CheckpointRefused("unavailable", reason, error);
  }
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
  const verifier = sharedPlaneVerifier({ issuer: issuer.issuer, audience: source.audience, jwksUrl: issuer.jwksUrl });
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
      // A Node current decision expires two seconds after it is issued. Refuse
      // a token too near expiry to cover the rest of that short-lived decision.
      return claims && claims.exp * 1000 > Date.now() + 10_000 ? claims : null;
    } });
  return new SuperpipelineClient({ baseUrl: profile.sourceOrigin, boardId: profile.target.board_id,
    token: "", credential, fetch: boundedFetch });
}
