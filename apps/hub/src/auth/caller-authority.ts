/**
 * The caller's own authority, for an authorization decision.
 *
 * Design §5.7: "No authorization path calls the plane. The one named exception is resolving an
 * inbound Matrix sender to a principal for gate approvals." A caller's token
 * already says who they are and what they may do (contract §2: `sub`, `principalKind`,
 * `mayDispatch`, `mayGrantReach`, and `scope` for agents and services). The auth middleware
 * carries that on `AuthUser.authority`, and every console/API authorization check asks this
 * module rather than reading the directory, so a request carrying a valid token is
 * answered from the token even while the plane is down.
 *
 * A caller with no token authority (the static API_TOKEN, or a background path that acts for a
 * station's owner, who is not the one asking) has nothing to read but the directory. Those reads
 * fail closed as `OrgPlaneUnavailable` — a 503 that says the plane could not be reached — never
 * as an unexplained 500 and never as "you are not permitted".
 */
import type { OrgPlaneTokenClaims } from "@agentpod/contract";
import type { PrincipalKind } from "../db/schema/organization";
import { OrgPlaneError } from "../services/org-plane/client";
import { getGrant, type Grant } from "../services/grants";
import { principalById } from "../services/principals";

/** What a plane token says its bearer may do. Set by the auth middleware for a plane token. */
export interface TokenAuthority {
  principalKind: PrincipalKind;
  /** Bare `prn_` ids (contract §2). */
  mayDispatch: string[];
  mayGrantReach: boolean;
  /** Grant scopes — read only from an agent's or a service's token (contract §2). Empty for a human. */
  scopes: string[];
}

export function authorityFromClaims(claims: OrgPlaneTokenClaims): TokenAuthority {
  const machine = claims.principalKind === "agent" || claims.principalKind === "service";
  return {
    principalKind: claims.principalKind,
    mayDispatch: Array.isArray(claims.mayDispatch) ? claims.mayDispatch.filter((v) => typeof v === "string") : [],
    mayGrantReach: claims.mayGrantReach === true,
    // A human's `scope` is the OAuth scope string, never a grant.
    scopes: machine ? (claims.scope ?? "").split(" ").filter(Boolean) : [],
  };
}

/** Anything with an id and, under the plane, the authority its token carried. `AuthUser` is one. */
export interface Caller {
  id: string;
  authority?: TokenAuthority;
}
/** A bare id is a caller with no token to read: a station's owner on a background path. */
export type CallerRef = string | Caller;

/** The plane was needed for an answer and could not give one. Surfaces as 503. */
export class OrgPlaneUnavailable extends Error {
  readonly status = 503 as const;
  constructor(readonly planeError: OrgPlaneError) {
    super(`the organization plane could not be reached to authorize this (${planeError.code})`);
    this.name = "OrgPlaneUnavailable";
  }
}

export function isOrgPlaneUnavailable(e: unknown): e is OrgPlaneUnavailable {
  return e instanceof OrgPlaneUnavailable;
}

/** The body every route answers an `OrgPlaneUnavailable` with. */
export const ORG_PLANE_UNAVAILABLE_BODY = {
  error: "org_plane_unavailable",
  message: "The organization plane could not be reached to check this permission. Try again shortly.",
} as const;

/**
 * The 503 body for a plane outage, or null when `err` is not one. The app's error handler uses it,
 * so a plane read that could not be answered — an authorization read with no token to answer it,
 * or a display read (a handle, a target principal) — is a clear 503 rather than a 500.
 */
export function orgPlaneOutageBody(err: unknown): typeof ORG_PLANE_UNAVAILABLE_BODY | null {
  return err instanceof OrgPlaneUnavailable || err instanceof OrgPlaneError ? ORG_PLANE_UNAVAILABLE_BODY : null;
}

const idOf = (c: CallerRef) => (typeof c === "string" ? c : c.id);
const authorityOf = (c: CallerRef) => (typeof c === "string" ? undefined : c.authority);

async function directoryRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof OrgPlaneError) throw new OrgPlaneUnavailable(e);
    throw e;
  }
}

/**
 * The caller's principal, or null. With a token: the token's `sub` (which is `AuthUser.id`) and
 * `principalKind` — no read. Without one: the directory.
 */
export async function callerPrincipal(caller: CallerRef): Promise<{ id: string; kind: PrincipalKind } | null> {
  const authority = authorityOf(caller);
  if (authority) return { id: idOf(caller), kind: authority.principalKind };
  // An account id IS the principal id (contract §2), whatever its kind: a route that refuses a
  // non-human caller must be able to see one here, not a null that reads as "no principal".
  return directoryRead(() => principalById(idOf(caller)));
}

/**
 * The grant held by `principalId`, which the caller resolved with `callerPrincipal`. With a token
 * naming that principal: the token's claims — no read. Otherwise: the directory.
 */
export async function callerGrant(caller: CallerRef, principalId: string): Promise<Grant | null> {
  const authority = authorityOf(caller);
  if (authority && principalId === idOf(caller)) {
    return {
      mayDispatch: [...authority.mayDispatch],
      mayGrantReach: authority.mayGrantReach,
      scopes: [...authority.scopes],
    };
  }
  return directoryRead(() => getGrant(principalId));
}
