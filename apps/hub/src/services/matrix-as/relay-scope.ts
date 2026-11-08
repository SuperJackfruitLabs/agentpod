/**
 * When the SuperPipeline relay's token may be used for a board (`bridge/relay.ts`): the one
 * decision, shared by the push subscription, the question sweep and the push route, so the three
 * cannot come to disagree about which workspace's room an approval request lands in.
 *
 * The relay credential is one workspace's, and an approval request's preview carries every argument
 * in full. So the token is used for a board only when (1) the tenant the caller resolved for the
 * board — the same tenant it will project into — is the relay's, and (2) no other tenant on this hub
 * knows the board: a board rostered or dispatched under several tenants has no single owner here,
 * and is refused the relay (logged once per board).
 */

import type { SuperpipelineRelay } from "../bridge";
import { createLogger } from "../../utils/logger";

const log = createLogger("superpipeline-relay");
const warnedAmbiguous = new Set<string>();

export type TenantsForBoard = (boardId: string) => Promise<string[]>;

async function defaultTenantsForBoard(boardId: string): Promise<string[]> {
  const { tenantsForBoard } = await import("./gate-reads");
  return tenantsForBoard(boardId);
}

/**
 * The relay token for `boardId` as seen by `tenantId` (the tenant the caller projects into), or
 * null. Null when there is no tenant, when another tenant also knows the board, or when the relay is
 * another workspace's.
 */
export async function relayTokenForBoard(
  relay: SuperpipelineRelay,
  tenantId: string | null,
  boardId: string,
  tenantsForBoard: TenantsForBoard = defaultTenantsForBoard,
): Promise<string | null> {
  if (!tenantId) return null;
  const tenants = await tenantsForBoard(boardId);
  if (tenants.length !== 1 || tenants[0] !== tenantId) {
    if (tenants.length > 1 && !warnedAmbiguous.has(boardId)) {
      warnedAmbiguous.add(boardId);
      log.warn("a board known to several tenants never gets the relay; its approval requests stay out of chat", {
        boardId,
        tenants: tenants.length,
      });
    }
    return null;
  }
  return relay.tokenFor(tenantId);
}
