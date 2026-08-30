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
