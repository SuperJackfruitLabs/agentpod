/**
 * The hub's home workspace (workspace authority spec, W2/W3 as superseded 2026-10-22).
 *
 * Owners and admins of the workspace that owns this hub's service credential operate the hub. The
 * hub learns that workspace from the plane: it asks for a service token with its own credential
 * (`POST /api/token/service`) and reads the token's `org` claim, which the plane sets to the org
 * the service principal belongs to. Nobody has to configure anything, so a self-hosted hub works
 * with zero bootstrap; on the hosted hub the service principal sits in our org, so a customer's
 * owner never becomes an operator of it.
 *
 * Until the org is known (plane down at boot) nobody is a derived operator: fail closed, retry in
 * the background. `HUB_HOME_ORG=org_…` may pin it: a pinned value is used at once, and when the
 * credential's org is also known and differs, the boot is refused (a mismatch found later, by the
 * background retry, clears the home org and logs, since the process is already serving).
 */
import { decodeJwt } from "jose";

import { orgPlane } from "../auth/org-plane/config";
import { createLogger } from "../utils/logger";
import { orgPlaneClient, type OrgPlaneClient } from "./org-plane/client";

const log = createLogger("hub-home-org");
const ORG_ID = /^org_[0-9a-f]{20}$/;

export class HubHomeOrgConfigError extends Error {
  constructor(value: string) {
    super(`HUB_HOME_ORG must be an organization id (org_ followed by 20 hex characters); not valid: ${JSON.stringify(value)}`);
    this.name = "HubHomeOrgConfigError";
  }
}

export class HubHomeOrgMismatchError extends Error {
  constructor(readonly pinned: string, readonly credential: string) {
    super(`HUB_HOME_ORG is ${pinned}, but the hub's service credential belongs to ${credential}; refusing to boot`);
    this.name = "HubHomeOrgMismatchError";
  }
}

/** Null when unset or blank. Throws on a malformed value. */
export function parseHubHomeOrg(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (!ORG_ID.test(v)) throw new HubHomeOrgConfigError(v);
  return v;
}

let homeOrg: string | null = null;

/** The hub's home workspace, or null while it is not known (no derived operators). */
export function hubHomeOrg(): string | null {
  return homeOrg;
}

export function setHubHomeOrgForTests(org: string | null): () => void {
  const prev = homeOrg;
  homeOrg = org;
  return () => {
    homeOrg = prev;
  };
}

/** The org the service credential belongs to: the `org` claim of a service token the plane mints for it. */
export async function credentialOrg(client: OrgPlaneClient, audience: string): Promise<string> {
  const { accessToken } = await client.serviceToken(audience);
  const org = decodeJwt(accessToken).org;
  if (typeof org !== "string" || !ORG_ID.test(org)) throw new Error("the plane's service token carries no org");
  return org;
}

export interface LearnOptions {
  client?: OrgPlaneClient;
  audience?: string;
  pinned?: string | null;
  /** Delay before each background retry, ms. */
  retryMs?: (attempt: number) => number;
}

/**
 * Learn the home org. Resolves once the first attempt is done: the org is set, or (plane down)
 * it stays unknown (or pinned) and a background retry keeps trying. Rejects with
 * `HubHomeOrgMismatchError` when a pin disagrees with the credential: the caller refuses the boot.
 * Returns a stop function for the background retry.
 */
export async function learnHubHomeOrg(o: LearnOptions = {}): Promise<() => void> {
  const client = o.client ?? orgPlaneClient();
  const audience = o.audience ?? orgPlane().audience;
  const pinned = o.pinned === undefined ? parseHubHomeOrg(process.env.HUB_HOME_ORG) : o.pinned;
  const retryMs = o.retryMs ?? ((n) => Math.min(60_000, 2_000 * 2 ** n));
  homeOrg = pinned;

  const attempt = async (): Promise<boolean> => {
    const org = await credentialOrg(client, audience);
    if (pinned && org !== pinned) throw new HubHomeOrgMismatchError(pinned, org);
    homeOrg = org;
    log.info("hub home workspace learned", { org, pinned: Boolean(pinned) });
    return true;
  };

  try {
    await attempt();
    return () => {};
  } catch (e) {
    if (e instanceof HubHomeOrgMismatchError) throw e;
    log.error(
      pinned
        ? "could not confirm the hub's home workspace from the plane; using HUB_HOME_ORG, retrying in the background"
        : "could not learn the hub's home workspace from the plane; no workspace owner/admin is a hub operator until it is known; retrying in the background",
      { error: e instanceof Error ? e.message : String(e) },
    );
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = (n: number) => {
    timer = setTimeout(async () => {
      if (stopped) return;
      try {
        await attempt();
      } catch (e) {
        if (e instanceof HubHomeOrgMismatchError) {
          homeOrg = null;
          log.error(`${e.message}; no derived hub operators until this is fixed`);
          return;
        }
        log.warn("hub home workspace still unknown; retrying", { error: e instanceof Error ? e.message : String(e) });
        loop(n + 1);
      }
    }, retryMs(n));
    (timer as { unref?: () => void }).unref?.();
  };
  loop(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
