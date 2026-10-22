/**
 * `HUB_OPERATORS` → `hub_operators` (workspace authority spec, W3).
 *
 * The hub operator seat is set from configuration, never from SQL: `HUB_OPERATORS=prn_…,prn_…`
 * is read at boot and the table is made to match it — listed principals are added, unlisted ones
 * removed.
 *
 * **Only when it is set.** Unset (or blank) leaves the table exactly as it is, so a deployment
 * whose env file has not been given the list yet keeps the seats it already has instead of losing
 * every one of them on the release that introduces this. A blank value counts as unset, so the
 * env cannot empty the table: a hub with no operator could not change its own provider settings.
 *
 * A malformed entry refuses the boot (validate-config.ts reports it; `reconcileHubOperators`
 * throws before touching the table), because a typo that silently dropped an operator would
 * surface only when someone needed the seat.
 */
import { inArray, notInArray } from "drizzle-orm";

import { db } from "../db/drizzle";
import { hubOperators } from "../db/schema/operators";
import { parseHubOperators } from "./hub-operators-config";

export { HubOperatorsConfigError, parseHubOperators } from "./hub-operators-config";

/**
 * Make `hub_operators` match `HUB_OPERATORS`. Returns null when it is unset (nothing done),
 * otherwise what changed.
 */
export async function reconcileHubOperators(
  raw: string | undefined = process.env.HUB_OPERATORS,
): Promise<{ added: string[]; removed: string[] } | null> {
  const ids = parseHubOperators(raw);
  if (ids === null) return null;
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(hubOperators)
      .where(notInArray(hubOperators.principalId, ids))
      .returning({ id: hubOperators.principalId });
    const existing = await tx
      .select({ id: hubOperators.principalId })
      .from(hubOperators)
      .where(inArray(hubOperators.principalId, ids));
    const have = new Set(existing.map((r) => r.id));
    const added = ids.filter((id) => !have.has(id));
    if (added.length > 0) {
      await tx
        .insert(hubOperators)
        .values(added.map((principalId) => ({ principalId, createdBy: "HUB_OPERATORS" })))
        .onConflictDoNothing();
    }
    return { added, removed: removed.map((r) => r.id) };
  });
}
