import { and, eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { principalIdentities } from "../db/schema/identities";
import { BOOTSTRAP_ORG_ID, principals, type PrincipalKind } from "../db/schema/organization";
import { prefixedId } from "../utils/ids";

export async function createPrincipal(input: {
  kind: PrincipalKind;
  handle: string;
  displayName?: string;
  /** When present, links the Better Auth user as this principal's login identity. */
  userId?: string;
}): Promise<string> {
  const id = prefixedId("prn");
  await db.insert(principals).values({
    id,
    kind: input.kind,
    orgId: BOOTSTRAP_ORG_ID,
    handle: input.handle,
    displayName: input.displayName ?? null,
  });
  if (input.userId) {
    await db.insert(principalIdentities).values({
      id: crypto.randomUUID(),
      principalId: id,
      system: "better-auth",
      externalId: input.userId,
    });
  }
  return id;
}

/**
 * The principal behind a Better Auth user, or null.
 *
 * Returns the id together with the kind, not the bare id: Task 4 uses this as
 * its default principal resolver and needs both to answer "who is this and
 * what is it" in one round trip — a second query for kind would be two round
 * trips answering one question.
 *
 * Null rather than a fallback: an unmapped caller must fail closed, for the same
 * reason `buildTokenPayload` refuses to mint a token when no tenant resolves.
 */
export async function principalForUser(
  userId: string
): Promise<{ id: string; kind: PrincipalKind; suspendedAt: Date | null } | null> {
  const [row] = await db
    .select({ id: principals.id, kind: principals.kind, suspendedAt: principals.suspendedAt })
    .from(principalIdentities)
    .innerJoin(principals, eq(principals.id, principalIdentities.principalId))
    .where(
      and(eq(principalIdentities.system, "better-auth"), eq(principalIdentities.externalId, userId))
    )
    .limit(1);
  return row ? { id: row.id, kind: row.kind as PrincipalKind, suspendedAt: row.suspendedAt } : null;
}

/**
 * A principal by its own id, or null.
 *
 * For a caller that already holds a `prn_…` id it obtained by an explicit
 * lookup elsewhere — `mintPrincipalAssertion` reading `principal_identities`
 * by mxid, for instance — and must never have that id re-resolved through
 * Better Auth: `principalForUser` looks for a Better Auth external id, which
 * a principal id is not, and would answer null for every one of these
 * callers regardless of whether the principal exists.
 *
 * Null rather than a fallback, for the same reason `principalForUser` is:
 * an id that names nobody must fail closed, not mint for a default.
 */
export async function principalById(
  id: string
): Promise<{ id: string; kind: PrincipalKind; suspendedAt: Date | null } | null> {
  const [row] = await db
    .select({ id: principals.id, kind: principals.kind, suspendedAt: principals.suspendedAt })
    .from(principals)
    .where(eq(principals.id, id))
    .limit(1);
  return row ? { id: row.id, kind: row.kind as PrincipalKind, suspendedAt: row.suspendedAt } : null;
}

/**
 * Stop a principal from being allowed to act, from now.
 *
 * Suspension rather than deletion: deleting a principal cascades its
 * identities and grants away, destroying the audit trail exactly when someone
 * wants to read it. `buildTokenPayload` refuses to mint for a suspended
 * principal on both subject paths — a session caller whose principal is
 * suspended is exactly as suspended as an agent.
 */
export async function suspendPrincipal(id: string): Promise<void> {
  await db.update(principals).set({ suspendedAt: new Date() }).where(eq(principals.id, id));
}

/** Lift a suspension. The principal can be minted for again. */
export async function restorePrincipal(id: string): Promise<void> {
  await db.update(principals).set({ suspendedAt: null }).where(eq(principals.id, id));
}

/**
 * A principal's immutable `handle`, or null.
 *
 * This is what an agent's Matrix identity is now built from
 * (`charter` → decisions/2026-08-30-an-agent-is-a-principal.md): `names.ts`'s
 * `bridgeUserId`/`bridgeLocalpart` take a handle, not a station, so every
 * caller that used to derive an agent's mxid from `(nodeName, stationKey)`
 * resolves the station's occupying principal to this instead. Kept here
 * rather than let the matrix modules query `principals` themselves, so schema
 * access to that table stays in the one service that owns it.
 *
 * Null both when the id names nobody and when a station has none — the two
 * cases a caller must treat alike: fail closed, never invent an address.
 */
export async function principalHandle(id: string): Promise<string | null> {
  const [row] = await db
    .select({ handle: principals.handle })
    .from(principals)
    .where(eq(principals.id, id))
    .limit(1);
  return row?.handle ?? null;
}

/**
 * Every principal, with the Better Auth login each one has if any.
 *
 * For the admin surface, and for one reason: a grant now names a principal id
 * on both sides — the row is keyed by one and every value in `mayDispatch` is
 * one — and a `prn_` id is not something a person can type from memory or
 * recognise on sight. Without this the console can only offer a text box and
 * hope, which is how an authorization surface stops being one people use.
 *
 * `userId` travels with the row so the console can put a name and an email
 * against a human principal without a second call and a second guess about
 * how to join the two id spaces. It is null for an agent or a service, which
 * is the ordinary case and not a gap.
 *
 * Unpaginated, deliberately: this is one row per person and per agent in one
 * organisation, which is the same order of magnitude as the fleet — and a
 * paginated picker that silently stopped at page one would offer a narrower
 * choice than exists, which on an authorization surface reads as "that agent
 * cannot be granted".
 */
export async function listPrincipals(): Promise<
  Array<{
    id: string;
    kind: PrincipalKind;
    handle: string;
    displayName: string | null;
    userId: string | null;
    /**
     * Whether this principal is suspended right now, and since when. Carried
     * here rather than left for a second call per row: an admin surface that
     * had to ask separately for every principal's state would either be slow
     * enough nobody used it, or would render the list before the state and
     * flash a wrong answer first.
     */
    suspendedAt: Date | null;
  }>
> {
  const rows = await db
    .select({
      id: principals.id,
      kind: principals.kind,
      handle: principals.handle,
      displayName: principals.displayName,
      suspendedAt: principals.suspendedAt,
      externalId: principalIdentities.externalId,
    })
    .from(principals)
    .leftJoin(
      principalIdentities,
      and(
        eq(principalIdentities.principalId, principals.id),
        eq(principalIdentities.system, "better-auth")
      )
    );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as PrincipalKind,
    handle: r.handle,
    displayName: r.displayName,
    userId: r.externalId ?? null,
    suspendedAt: r.suspendedAt,
  }));
}
