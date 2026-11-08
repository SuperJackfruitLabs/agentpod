/**
 * The SuperPipeline decision relay: an optional Accounts service credential holding
 * `approval-requests:relay`, so SuperToolkit approval requests reach chat.
 *
 * charter → "Waiting cards and broker approvals reach chat" §3–4, and SuperPipeline's rule that an
 * approval request — whose preview carries every argument in full — is listed on
 * `GET …/elicitations/pending` and pushed on `elicitation.pending` only to a service holding that
 * scope, never to an agent's token. The bridge's agent credentials keep doing everything else.
 *
 * `SUPERPIPELINE_RELAY_CREDENTIAL_FILE` names a file holding one line `svc_<20 hex>:<secret>`, the
 * shape of the hub's own `ORG_PLANE_SERVICE_CREDENTIAL_FILE`. Unset: approval requests simply do
 * not reach chat, as before. Set: the hub exchanges it at the plane (`POST /api/token/service`)
 * for a token whose audience is SuperPipeline, and uses that token to read a board's questions and
 * to register its `elicitation.pending` push — never to answer: answers stay the person's.
 *
 * **One workspace.** A service credential belongs to one workspace, which the plane writes as the
 * token's `org` claim. The token is handed out only for boards of the tenant that org maps to on
 * this hub (looked up, never created); every other workspace's boards keep their agent credential
 * and do not see approval requests. SuperPipeline scopes the token to the same workspace again.
 */

import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";

import { createOrgPlaneClient } from "../../auth/org-plane/client";
import { orgPlane } from "../../auth/org-plane/config";
import { existingTenantForOrg } from "../../auth/org-plane/tenant";
import { createLogger } from "../../utils/logger";

const log = createLogger("superpipeline-relay");

export const RELAY_CREDENTIAL_ENV = "SUPERPIPELINE_RELAY_CREDENTIAL_FILE";
const SVC = /^(svc_[0-9a-f]{20}):(\S+)$/;
/** A token is renewed this long before it expires. */
const RENEW_BEFORE_MS = 60_000;

export interface RelayCredential {
  id: string;
  secret: string;
}

/**
 * The relay credential from the environment: null when unset, or why it cannot be used. Checked at
 * boot (`validate-config.ts`): a credential an operator set and the hub cannot read must not
 * quietly mean "approval requests stay out of chat".
 */
export function readRelayCredential(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { ok: true; credential: RelayCredential | null } | { ok: false; message: string } {
  const path = (env[RELAY_CREDENTIAL_ENV] ?? "").trim();
  if (path === "") return { ok: true, credential: null };
  let raw: string;
  try {
    raw = readFile(path).trim();
  } catch {
    return { ok: false, message: "cannot be read" };
  }
  const m = SVC.exec(raw);
  if (!m?.[1] || !m[2]) return { ok: false, message: "must hold one line `svc_<20 hex>:<secret>`" };
  return { ok: true, credential: { id: m[1], secret: m[2] } };
}

/** Hands out the relay's SuperPipeline token, for its own workspace's boards only. */
export interface SuperpipelineRelay {
  /** The relay token when `tenantId` is the relay's workspace; null for any other, or when it cannot be had. */
  tokenFor(tenantId: string): Promise<string | null>;
  /** SuperPipeline refused the token (401/403): forget it, so the next use exchanges afresh. */
  invalidate(): void;
}

export interface RelayDeps {
  /** `POST /api/token/service` with the relay credential, for SuperPipeline's audience. */
  exchange(): Promise<{ accessToken: string; expiresIn: number }>;
  /** The tenant an org already has on this hub; null when none. Never creates one. */
  tenantForOrg(org: string): Promise<string | null>;
  now?(): number;
}

/** After a refused or failed exchange, nothing is asked again (or logged again) for this long. */
export const RELAY_RETRY_AFTER_MS = 60_000;

export function createSuperpipelineRelay(deps: RelayDeps): SuperpipelineRelay {
  const now = () => (deps.now ? deps.now() : Date.now());
  let cached: { token: string; tenantId: string | null; renewAt: number } | null = null;
  /** Until when a failed exchange is the answer: one exchange and one log line per window. */
  let failedUntil = 0;
  /** One exchange at a time: concurrent callers share it. */
  let inFlight: Promise<{ token: string; tenantId: string | null } | null> | null = null;

  async function exchange(): Promise<{ token: string; tenantId: string | null } | null> {
    try {
      const { accessToken, expiresIn } = await deps.exchange();
      const org = decodeJwt(accessToken).org;
      if (typeof org !== "string" || org === "") {
        log.warn("the relay token carries no workspace; approval requests are not relayed");
        failedUntil = now() + RELAY_RETRY_AFTER_MS;
        return null;
      }
      const tenantId = await deps.tenantForOrg(org);
      if (!tenantId) log.warn("the relay credential's workspace has no tenant on this hub; nothing is relayed", { org });
      cached = { token: accessToken, tenantId, renewAt: now() + Math.max(0, expiresIn * 1000 - RENEW_BEFORE_MS) };
      return cached;
    } catch (err) {
      // Never the credential or the token: only that the exchange failed. Logged once per window.
      log.warn("could not exchange the relay credential; approval requests wait for the next try", {
        error: err instanceof Error ? err.message : String(err),
        retryInMs: RELAY_RETRY_AFTER_MS,
      });
      cached = null;
      failedUntil = now() + RELAY_RETRY_AFTER_MS;
      return null;
    }
  }

  async function current(): Promise<{ token: string; tenantId: string | null } | null> {
    if (cached && now() < cached.renewAt) return cached;
    if (now() < failedUntil) return null;
    inFlight ??= exchange().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    tokenFor: async (tenantId) => {
      const c = await current();
      // The tenant rule: a workspace's credential is used for that workspace's boards and no other.
      return c && c.tenantId !== null && c.tenantId === tenantId ? c.token : null;
    },
    invalidate: () => {
      cached = null;
    },
  };
}

/**
 * The relay configured in the environment, or null when there is none (logged once: approval
 * requests do not reach chat). `audience` is SuperPipeline's base URL — the audience the hub's
 * per-answer assertions name too.
 */
export function superpipelineRelayFromEnv(audience: string): SuperpipelineRelay | null {
  const read = readRelayCredential(process.env);
  if (!read.ok || !read.credential) {
    log.info(`${RELAY_CREDENTIAL_ENV} is unset; SuperToolkit approval requests will not reach chat`);
    return null;
  }
  const client = createOrgPlaneClient({ url: orgPlane().url, credential: read.credential });
  return createSuperpipelineRelay({
    exchange: () => client.serviceToken(audience),
    tenantForOrg: (org) => existingTenantForOrg(org),
  });
}
