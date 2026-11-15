/** Proposed Hub-only service transport. No spa_ agent token or worker context enters this client. */
import { createOrgPlaneClient } from "../../auth/org-plane/client";
import { orgPlane, type OrgPlaneConfig } from "../../auth/org-plane/config";
import { createPlaneVerifier } from "../../auth/org-plane/verify";
import { parsePendingCheckpointClaim, type PendingCheckpointClaim } from "./checkpoint-claim";
import { canonicalCheckpoint, checkpointDigest } from "./checkpoint-json";
import { CheckpointRefused, parseCheckpointProfile, type CheckpointProfile } from "./checkpoint-profile";
import { parseCheckpointSource, parseSourceReceipt, parseSourceSnapshot, requireSourceBinding,
  type CheckpointSource, type CheckpointSourceReceipt, type CheckpointSourceSnapshot } from "./checkpoint-source";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
interface Options { plane?: OrgPlaneConfig; fetch?: Fetch }
export interface CheckpointServiceClient {
  /** GET permits an ended historical snapshot; callers must separately require active ownership before new effects. */
  source(claim: PendingCheckpointClaim): Promise<CheckpointSourceSnapshot>;
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
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const out = new Uint8Array(size); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

/** Explicit construction only: no production loader enables this proposed boundary.
 * The immutable profile is server-owned. Actual current station/tenant/control-pair checks remain mandatory at the port.
 */
export function createCheckpointServiceClient(configuration: CheckpointProfile, options: Options = {}): CheckpointServiceClient {
  const profile = parseCheckpointProfile(configuration);
  const plane = options.plane ?? orgPlane();
  const doFetch = options.fetch ?? fetch;
  const issuer = createOrgPlaneClient({ url: plane.url, credential: plane.serviceCredential,
    fetch: doFetch, timeoutMs: 5_000 });
  const verifier = createPlaneVerifier({ issuer: plane.issuer, audience: profile.sourceAudience,
    jwksUrl: plane.jwksUrl, fetch: doFetch });

  async function exchange(claim: PendingCheckpointClaim, scope: "checkpoints:read" | "checkpoints:submit", body?: string): Promise<Uint8Array> {
    // No automatic retry, redirect, ambient cookie, private error body, or token exposure.
    let token: string;
    try { token = (await issuer.serviceToken(profile.sourceAudience)).accessToken; }
    catch { throw new CheckpointRefused("authority"); }
    const claims = await verifier.verify(token);
    if (!claims || claims.principalKind !== "service" || claims.sub !== profile.reporterPrincipalId ||
      claims.org !== profile.organizationId || !claims.ent.includes("superpipeline") || claims.act !== undefined ||
      !(claims.scope?.split(/\s+/).includes(scope)) || claims.exp * 1000 <= Date.now()) throw new CheckpointRefused("authority");
    if (claim.policy.reporterPrincipalId !== claims.sub || claim.tenantId !== profile.sourceTenantId ||
      claim.boardId !== profile.target.board_id) throw new CheckpointRefused("authority");
    if (body !== undefined && Buffer.byteLength(body, "utf8") > 65_536) throw new CheckpointRefused("invalid");
    const path = `/v1/boards/${encodeURIComponent(claim.boardId)}/runs/${encodeURIComponent(claim.runId)}/checkpoint-source`;
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
        if (response.status !== 200 || response.headers.get("content-encoding") && response.headers.get("content-encoding") !== "identity")
          throw new CheckpointRefused(body === undefined ? "unavailable" : "uncertain");
        return boundedBody(response);
      })()]);
      // A service JWT expiring during the await cannot support a fresh observation.
      if (claims.exp * 1000 <= Date.now()) throw new CheckpointRefused("authority");
      return raw;
    } catch (error) {
      if (error instanceof CheckpointRefused) throw error;
      throw new CheckpointRefused(body === undefined ? "unavailable" : "uncertain");
    } finally { if (timerListener) signal.removeEventListener("abort", timerListener); }
  }
  return {
    source: async (value) => {
      const claim = parsePendingCheckpointClaim(value);
      return parseSourceSnapshot(await exchange(claim, "checkpoints:read"), profile, claim);
    },
    admit: async (value, input) => {
      const claim = parsePendingCheckpointClaim(value);
      const source = parseCheckpointSource(input);
      requireSourceBinding(profile, claim, source);
      const body = canonicalCheckpoint(source);
      const receipt = parseSourceReceipt(await exchange(claim, "checkpoints:submit", body));
      if (receipt.runId !== claim.runId || receipt.leaseEpoch !== claim.leaseEpoch ||
        receipt.sourceDigest !== await checkpointDigest(source)) throw new CheckpointRefused("source");
      return receipt;
    },
  };
}
