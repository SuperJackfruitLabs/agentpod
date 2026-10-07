/**
 * A human's approval from chat, carried to another plane as that human (contract §3.4b).
 *
 * The hub signs nothing (design §9: "the hub holds no signing key"). The org plane signs: the hub
 * asks `POST /api/token/assertion` with the sender's Matrix identity, and the plane resolves the
 * human itself, so no caller can name whom to assert. The token's `sub` is the human and its
 * `act.sub` the hub's service principal — a consumer can tell "this person approved" from "the
 * hub approved on their behalf".
 *
 * Moved here from `auth/service-signing.ts` when that module (and the hub's own signing key) was
 * deleted after the rollback window (P3 plan, Task 17).
 */
import { decodeJwt } from "jose";
import { OrgPlaneError, orgPlaneClient, type OrgPlaneClient } from "../../services/org-plane/client";

/**
 * Who a human's approval from chat is asserted as: the principal the hub resolved from the
 * sender, and the sender itself.
 */
export interface AssertionSubject {
  /** Resolved by the hub from the sender; the plane's answer is checked against it. */
  principalId: string;
  /** The Matrix sender. This, not the prn_, is what is asserted (contract §3.4b). */
  senderMxid: string;
}

/** The plane asserted somebody other than the principal this hub resolved the sender to. */
export class AssertionMismatch extends Error {
  constructor(expected: string, got: unknown) {
    super(`the org plane asserted ${String(got)} for a sender this hub resolved to ${expected}`);
    this.name = "AssertionMismatch";
  }
}

/**
 * The plane's assertion for the sender. A refusal or an unreachable plane propagates as
 * `OrgPlaneError` — there is no hub-signed fallback.
 *
 * Defence in depth: the plane's `sub` must be the principal this hub resolved the same sender to.
 * A mismatch means the identity link changed between the two reads, and the answer is refused
 * rather than recorded under somebody else.
 */
export async function assertPrincipal(
  input: AssertionSubject & { audience: string },
  deps: { client?: () => Pick<OrgPlaneClient, "assertionToken"> } = {},
): Promise<string> {
  const { accessToken } = await (deps.client ?? orgPlaneClient)().assertionToken(
    { system: "matrix", externalId: input.senderMxid },
    input.audience,
  );
  let sub: unknown;
  try {
    sub = decodeJwt(accessToken).sub;
  } catch {
    sub = undefined;
  }
  if (sub !== input.principalId) throw new AssertionMismatch(input.principalId, sub);
  return accessToken;
}

/**
 * The receipt code for an assertion that could not be had, or null for any other error (which the
 * caller rethrows, as it always has).
 *
 * - `IDENTITY_UNAVAILABLE`: the plane could not be reached (or answered 5xx) — try again.
 * - `ASSERTION_REFUSED`: the plane answered and refused (403/404/409/423).
 * - `ASSERTION_MISMATCH`: the plane asserted somebody else.
 */
export function assertionFailureCode(error: unknown): "IDENTITY_UNAVAILABLE" | "ASSERTION_REFUSED" | "ASSERTION_MISMATCH" | null {
  if (error instanceof AssertionMismatch) return "ASSERTION_MISMATCH";
  if (error instanceof OrgPlaneError) {
    return error.status === 0 || error.status >= 500 ? "IDENTITY_UNAVAILABLE" : "ASSERTION_REFUSED";
  }
  return null;
}
