/**
 * The bridge's dispatch grant (spec 2026-10-23, plan step 10).
 *
 * A dispatched card runs as the station's adopter (the roster's `hubUserId`, read from the
 * station). Salaam's authority check, and the control pair when it is enforced, require that
 * person's org-plane grant to name the station's agent in `mayDispatch`. Nothing in onboarding
 * wrote it: `fleet staff assign` grants the CALLER (and only with `dispatch: "me"`), and the
 * person adding the roster entry is often not the adopter. The bridge then refused every card
 * with "dispatch grant was withdrawn".
 *
 * Decided here: putting a station on the bridge (`fleet bridge add`, or `fleet bridge set` that
 * enables it or moves it) is the workspace admin's statement that this station's agent is
 * dispatched from that board as its adopter, so the hub records the grant then. It adds exactly
 * one agent (the station's own occupant) to exactly one person (the station's adopter); it never
 * removes anything, and it never grants the caller.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { principalDirectory, type PrincipalDirectory } from "../org-plane/directory";
import { grantDispatchTo } from "../org-plane/agent-placement";
import { createLogger } from "../../utils/logger";

const log = createLogger("bridge-dispatch-grant");

export type BridgeDispatchGrant =
  /** The adopter already holds it. */
  | { state: "present"; adopter: string; agent: string }
  /** Recorded now. */
  | { state: "granted"; adopter: string; agent: string }
  /** No agent at the station yet: nothing to grant (staff the station first). */
  | { state: "no_agent" }
  /** The adopter is not a person at the org plane (the static API token adopted it). */
  | { state: "adopter_not_a_person"; adopter: string }
  /** The plane could not be asked, or refused the write. */
  | { state: "unknown"; reason: string };

export interface DispatchGrantDeps {
  directory?: () => Pick<PrincipalDirectory, "principal" | "invalidate">;
  grant?: (humanId: string, agentId: string) => Promise<void>;
}

async function stationFacts(tenantId: string, stationId: string) {
  const [row] = await db
    .select({ userId: stations.userId, principalId: stations.principalId })
    .from(stations)
    .where(and(eq(stations.tenantId, tenantId), eq(stations.id, stationId)));
  return row ?? null;
}

/** Read-only: does the bridge's user hold the grant? Never writes. */
export async function checkBridgeDispatchGrant(
  tenantId: string,
  stationId: string,
  deps: DispatchGrantDeps = {},
): Promise<BridgeDispatchGrant | { state: "missing"; adopter: string; agent: string }> {
  const facts = await stationFacts(tenantId, stationId);
  if (!facts?.principalId) return { state: "no_agent" };
  try {
    const person = await (deps.directory ?? principalDirectory)().principal(facts.userId);
    if (!person || person.kind !== "human") return { state: "adopter_not_a_person", adopter: facts.userId };
    return person.grant?.mayDispatch.includes(facts.principalId)
      ? { state: "present", adopter: facts.userId, agent: facts.principalId }
      : { state: "missing", adopter: facts.userId, agent: facts.principalId };
  } catch (e) {
    return { state: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Make sure the bridge's user may dispatch the station's agent; grant it if not. */
export async function ensureBridgeDispatchGrant(
  tenantId: string,
  stationId: string,
  deps: DispatchGrantDeps = {},
): Promise<BridgeDispatchGrant> {
  const current = await checkBridgeDispatchGrant(tenantId, stationId, deps);
  if (current.state !== "missing") return current;
  try {
    await (deps.grant ?? ((h, a) => grantDispatchTo(h, a, deps.directory ? { directory: deps.directory } : {})))(
      current.adopter,
      current.agent,
    );
    log.info("granted the bridge's user dispatch over the station's agent", {
      stationId,
      adopter: current.adopter,
      agent: current.agent,
    });
    return { state: "granted", adopter: current.adopter, agent: current.agent };
  } catch (e) {
    return { state: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}
