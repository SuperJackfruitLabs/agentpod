/** Proposed Hub-only service transport. No spa_ agent token or worker context enters this client. */
import { createOrgPlaneClient } from "../../auth/org-plane/client";
import { orgPlane, type OrgPlaneConfig } from "../../auth/org-plane/config";
import { sharedPlaneVerifier } from "../../auth/org-plane/verify";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint, checkpointDigest, parseCheckpointJSON } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { parseCheckpointSource, parseSourceReceipt, parseSourceSnapshot, requireSourceBinding,
  type CheckpointSource, type CheckpointSourceReceipt, type CheckpointSourceSnapshot } from "./checkpoint-source";

import { checkpointSettlementSchema, checkedCheckpointReceipt, type CheckpointReceipt } from "./checkpoint-settlement-data";
import { noteCheckpoint } from "./checkpoint-log";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Options { plane?: OrgPlaneConfig; fetch?: Fetch }
export interface CheckpointServiceClient {
  /** GET permits an ended historical snapshot; callers must separately require active ownership before new effects. */
  settle(claim: PendingCheckpointClaim, retainedBody: string): Promise<CheckpointReceipt>;
  receipt(claim: PendingCheckpointClaim, retainedBody: string): Promise<CheckpointReceipt | undefined>;
  source(claim: PendingCheckpointClaim): Promise<CheckpointSourceSnapshot>;
  /** Verified issuer expiry only; the bearer itself remains private to the client. */
  sourceEvidence(claim: PendingCheckpointClaim): Promise<{ snapshot: CheckpointSourceSnapshot; reporterExpiresAtMs: number }>;
  /** Caller durably retains this exact source before admission; uncertainty never authorizes another execution. */
  admit(claim: PendingCheckpointClaim, source: CheckpointSource): Promise<CheckpointSourceReceipt>;
}

async function boundedBody(response: Response): Promise<Uint8Array> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65_536)) throw new CheckpointRefused("source");
  const reader = response.body?.getReader();
  if (!reader) throw new CheckpointRefused("source");
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 65_536) throw new CheckpointRefused("source");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); } // silent-catch-ok: releasing a reader already read or failed
  const out = new Uint8Array(size); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

/** Explicit construction only; the proposed installation flag is off by default.
 * The immutable profile is server-owned. Actual current station/tenant/control-pair checks remain mandatory at the port.
 */
export function createCheckpointServiceClient(configuration: CheckpointProfile, options: Options = {}): CheckpointServiceClient {
  const profile = parseCheckpointProfile(configuration);
  const plane = options.plane ?? orgPlane();
  const doFetch = options.fetch ?? fetch;
  const issuer = createOrgPlaneClient({ url: plane.url, credential: plane.serviceCredential,
    fetch: doFetch, timeoutMs: 5_000 });
  const verifier = sharedPlaneVerifier({ issuer: plane.issuer, audience: profile.sourceAudience,
    jwksUrl: plane.jwksUrl, fetch: doFetch });

  async function exchange(claim: PendingCheckpointClaim, scope: "checkpoints:read" | "checkpoints:submit", body?: string, kind: "source" | "settlement" | "receipt" = "source"): Promise<{ raw: Uint8Array; expiresAtMs: number; missing: boolean }> {
    // No automatic retry, redirect, ambient cookie, private error body, or token exposure.
    let token: string;
    try { token = (await issuer.serviceToken(profile.sourceAudience)).accessToken; }
    catch (error) {
      noteCheckpoint("service", "service.token", { audience: profile.sourceAudience }, error);
      throw new CheckpointRefused("authority", undefined, error);
    }
    const claims = await verifier.verify(token);
    if (!claims || claims.principalKind !== "service" || claims.sub !== profile.reporterPrincipalId ||
      claims.org !== profile.organizationId || !claims.ent.includes("superpipeline") || claims.act !== undefined ||
      !(claims.scope?.split(/\s+/).includes(scope)) || claims.exp * 1000 <= Date.now()) throw new CheckpointRefused("authority");
    if (claim.policy.reporterPrincipalId !== claims.sub || claim.tenantId !== profile.sourceTenantId ||
      claim.boardId !== profile.target.board_id) throw new CheckpointRefused("authority");
    if (body !== undefined && Buffer.byteLength(body, "utf8") > 65_536) throw new CheckpointRefused("invalid");
    const suffix = kind === "source" ? "checkpoint-source" : kind === "settlement" ? "checkpoint-settlements" : "checkpoint";
    const path = `/v1/boards/${encodeURIComponent(claim.boardId)}/runs/${encodeURIComponent(claim.runId)}/${suffix}`;
    let missing = false;
    const signal = AbortSignal.timeout(5_000);
    let timerListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      timerListener = () => reject(new CheckpointRefused(body === undefined ? "unavailable" : "uncertain"));
      signal.addEventListener("abort", timerListener, { once: true });
    });
    try {
      const raw = await Promise.race([aborted, (async () => {
        const response = await doFetch(profile.sourceOrigin + path, { method: body === undefined ? "GET" : "POST",
          redirect: "error", credentials: "omit", signal, headers: {
            authorization: `Bearer ${token}`, accept: "application/json", "accept-encoding": "identity",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          }, ...(body === undefined ? {} : { body }) });
        if (response.status === 401 || response.status === 403) throw new CheckpointRefused("authority");
        if (kind === "receipt" && response.status === 404) {
          const missingBody = await boundedBody(response);
          if (canonicalCheckpoint(parseCheckpointJSON(missingBody)) !== canonicalCheckpoint({ error: { code: "CHECKPOINT_RECEIPT_MISSING" } }))
            throw new CheckpointRefused("unavailable");
          missing = true;
          return missingBody;
        }
        if (response.status !== 200 || response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")
          throw new CheckpointRefused(body === undefined ? "unavailable" : "uncertain");
        return boundedBody(response);
      })()]);
      // A service JWT expiring during the await cannot support a fresh observation.
      if (claims.exp * 1000 <= Date.now()) throw new CheckpointRefused("authority");
      return { raw, expiresAtMs: claims.exp * 1000, missing };
    } catch (error) {
      if (error instanceof CheckpointRefused) throw error;
      noteCheckpoint("service", body === undefined ? "service.read" : "service.write", { kind }, error);
      throw new CheckpointRefused(body === undefined ? "unavailable" : "uncertain", undefined, error);
    } finally { if (timerListener) signal.removeEventListener("abort", timerListener); }
  }
  function retainedBody(value: PendingCheckpointClaim, body: string): PendingCheckpointClaim {
    const claim = parsePendingCheckpointClaim(value);
    const submitted = checkpointSettlementSchema.parse(parseCheckpointJSON(new TextEncoder().encode(body)));
    const report = submitted.checkpoint;
    const binding = report.binding;
    if (canonicalCheckpoint(submitted) !== body || binding.boardId !== claim.boardId || binding.cardId !== claim.cardId ||
      binding.runId !== claim.runId || binding.stageKey !== claim.stageKey || binding.leaseEpoch !== claim.leaseEpoch ||
      binding.agentId !== claim.agentId || binding.nodeId !== profile.target.node_id || binding.stationId !== profile.target.station_id ||
      report.policyDigest !== claim.policyDigest || report.checkpoint.checkpointRepository !== profile.checkpointRepository ||
      report.checkpoint.members.length !== profile.repositories.length || report.checkpoint.members.some((m, index) => {
        const pin = profile.repositories[index];
        return !pin || pin.name !== m.name || pin.provider !== m.provider || pin.repository !== m.repository || pin.objectFormat !== m.objectFormat ||
          m.branch !== "card/" + claim.cardId;
      })) throw new CheckpointRefused("source");
    return claim;
  }
  return {
    settle: async (value, body) => {
      const claim = retainedBody(value, body);
      const reply = await exchange(claim, "checkpoints:submit", body, "settlement");
      return checkedCheckpointReceipt(reply.raw, body, profile.reporterPrincipalId);
    },
    receipt: async (value, body) => {
      const claim = retainedBody(value, body);
      const reply = await exchange(claim, "checkpoints:read", undefined, "receipt");
      return reply.missing ? undefined : checkedCheckpointReceipt(reply.raw, body, profile.reporterPrincipalId);
    },
    source: async (value) => {
      const claim = parsePendingCheckpointClaim(value);
      return parseSourceSnapshot((await exchange(claim, "checkpoints:read")).raw, profile, claim);
    },
    sourceEvidence: async (value) => {
      const claim = parsePendingCheckpointClaim(value);
      const response = await exchange(claim, "checkpoints:read");
      return { snapshot: parseSourceSnapshot(response.raw, profile, claim), reporterExpiresAtMs: response.expiresAtMs };
    },
    admit: async (value, input) => {
      const claim = parsePendingCheckpointClaim(value);
      const source = parseCheckpointSource(input);
      requireSourceBinding(profile, claim, source);
      const body = canonicalCheckpoint(source);
      const receipt = parseSourceReceipt((await exchange(claim, "checkpoints:submit", body)).raw);
      if (receipt.runId !== claim.runId || receipt.leaseEpoch !== claim.leaseEpoch ||
        receipt.sourceDigest !== await checkpointDigest(source)) throw new CheckpointRefused("source");
      return receipt;
    },
  };
}
