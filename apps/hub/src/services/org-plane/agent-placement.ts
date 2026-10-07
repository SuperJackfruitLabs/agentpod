/**
 * The writes the hub keeps under the org plane to place an agent (decision D3): create the agent
 * principal, link its Matrix id, and add it to the placing human's `mayDispatch`. Everything else
 * about principals and grants is done by a person at the plane's pages.
 *
 * A remote call cannot join the hub's setup transaction, so the agent is created first and, if
 * the local placement then fails, suspended (`abandonPlaneAgent`): the contract has no delete,
 * and a suspended agent cannot be used half-placed.
 */
import { bridgeUserId } from "../matrix-as/names";
import { orgPlaneClient, type OrgPlaneClient } from "./client";
import { principalDirectory, type PrincipalDirectory } from "./directory";
import { createLogger } from "../../utils/logger";

const log = createLogger("agent-placement");

export type PlacementDeps = {
  client?: () => Pick<OrgPlaneClient, "createAgent" | "linkIdentity" | "putGrant" | "suspend">;
  directory?: () => Pick<PrincipalDirectory, "principal" | "invalidate">;
};

/**
 * Create the agent at the plane and link its Matrix id (`@agent_<handle>:<domain>`), so the
 * plane's identity lookup can tell that sender is an agent (agentpod#608). No Matrix domain (no
 * bridge configured) means no link. An agent whose link failed is suspended before the failure
 * is thrown: it exists, but nothing placed it.
 */
export async function createPlaneAgent(
  input: { handle: string; displayName: string; matrixDomain: string | null },
  deps: PlacementDeps = {},
): Promise<string> {
  const client = (deps.client ?? orgPlaneClient)();
  const { id } = await client.createAgent({ handle: input.handle, displayName: input.displayName });
  (deps.directory ?? principalDirectory)().invalidate();
  if (input.matrixDomain) {
    try {
      await client.linkIdentity(id, "matrix", bridgeUserId(input.handle, input.matrixDomain));
    } catch (error) {
      await abandonPlaneAgent(id, deps);
      throw error;
    }
  }
  return id;
}

/** Whether an existing principal may be placed: an agent of this workspace, not suspended. */
export async function checkPlaneAgent(id: string, deps: PlacementDeps = {}): Promise<"ok" | "not-found" | "suspended"> {
  const p = await (deps.directory ?? principalDirectory)().principal(id);
  if (!p || p.kind !== "agent") return "not-found";
  return p.suspended ? "suspended" : "ok";
}

/**
 * Add `agentId` to the human's `mayDispatch`, keeping `mayGrantReach` and `scopes`.
 *
 * Read-modify-write: two placements by the same human in the same instant can lose one append.
 * The hub's local version serialised this under a row lock; the plane's PUT cannot (plan Risk
 * #4). Low frequency; the fix, if it ever bites, is an append operation at the plane.
 */
export async function grantDispatchTo(humanId: string, agentId: string, deps: PlacementDeps = {}): Promise<void> {
  const directory = (deps.directory ?? principalDirectory)();
  const current = (await directory.principal(humanId))?.grant ?? { mayDispatch: [], mayGrantReach: false, scopes: [] };
  if (current.mayDispatch.includes(agentId)) return;
  await (deps.client ?? orgPlaneClient)().putGrant(humanId, {
    mayDispatch: [...current.mayDispatch, agentId],
    mayGrantReach: current.mayGrantReach,
    scopes: current.scopes,
  });
  directory.invalidate(humanId);
}

/** Suspend an agent whose placement failed. Never throws: the placement's own failure is the answer. */
export async function abandonPlaneAgent(id: string, deps: PlacementDeps = {}): Promise<void> {
  try {
    await (deps.client ?? orgPlaneClient)().suspend(id);
  } catch (error) {
    log.error("could not suspend an agent whose placement failed; suspend it at the org plane", {
      id,
      error: String(error),
    });
  }
}
