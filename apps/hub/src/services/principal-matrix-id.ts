/**
 * A principal's Matrix id: whom to invite to a person's rooms, and whose Live Activity card an
 * agent's report belongs on.
 *
 * The organization plane owns identities, so this is its
 * `GET /api/principals/:id/identities?system=matrix` (contract §3.5) through the directory's 60 s
 * cache with last-good. A plane that cannot be reached with nothing cached throws `OrgPlaneError`,
 * as `principalForUser` does before it at every call site: "down" is not "has no Matrix id".
 *
 * Null is an ordinary answer: a person who has never linked a Matrix account.
 */
import { principalDirectory } from "./org-plane/directory";

export async function matrixIdForPrincipal(principalId: string): Promise<string | null> {
  const ids = await principalDirectory().identitiesOf(principalId, "matrix");
  return ids?.find((i) => i.system === "matrix")?.externalId ?? null;
}
