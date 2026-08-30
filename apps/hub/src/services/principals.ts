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
): Promise<{ id: string; kind: PrincipalKind } | null> {
  const [row] = await db
    .select({ id: principals.id, kind: principals.kind })
    .from(principalIdentities)
    .innerJoin(principals, eq(principals.id, principalIdentities.principalId))
    .where(
      and(eq(principalIdentities.system, "better-auth"), eq(principalIdentities.externalId, userId))
    )
    .limit(1);
  return row ? { id: row.id, kind: row.kind as PrincipalKind } : null;
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
): Promise<{ id: string; kind: PrincipalKind } | null> {
  const [row] = await db
    .select({ id: principals.id, kind: principals.kind })
    .from(principals)
    .where(eq(principals.id, id))
    .limit(1);
  return row ? { id: row.id, kind: row.kind as PrincipalKind } : null;
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
