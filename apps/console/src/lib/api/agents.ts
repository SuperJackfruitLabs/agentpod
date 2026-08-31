/**
 * Creating an agent, and putting it in a station — the console side of
 * `apps/hub/src/routes/agents-admin.ts`.
 *
 * Until this file, the only way an agent principal came into existence was a
 * seed script run by hand, and the only way it occupied a station was a
 * direct database write. `charter → decisions/2026-08-30-an-agent-is-a-
 * principal.md`: creating an agent is a deliberate act, and a station with no
 * occupying principal is dispatchable by nobody — correct, deliberate
 * behaviour that today has no operator-visible signal at all. This is that
 * signal's write half.
 */

import { http } from "./client";

/** The principal minted by POST /api/admin/agents. */
export interface CreatedAgent {
  id: string;
  kind: "human" | "agent" | "service";
  /** Immutable — what the agent's Matrix address is built from. Never editable after this call. */
  handle: string;
  displayName: string | null;
  suspendedAt: string | null;
}

/**
 * Mint a new agent principal. Does not put it anywhere — a station is
 * occupied by a separate call to {@link assignStationAgent}, because minting
 * an identity and handing it a station are two different acts with two
 * different refusals (a bad handle vs. a suspended assignee).
 *
 * Throws on 400 (a handle `clean()` would rewrite into a different Matrix
 * address) and 409 (the handle is already taken) — both readable via
 * `(err as Error).message`, which carries the hub's own sentence rather than
 * a generic failure.
 */
export function createAgent(input: { handle: string; displayName?: string }): Promise<CreatedAgent> {
  return http<CreatedAgent>("/api/admin/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

/**
 * Whether the assigned agent actually ended up with a Matrix room.
 *
 * The hub provisions one as part of the assignment, and provisioning talks
 * to a homeserver, which can be down. A failure there deliberately does NOT
 * undo the assignment — occupancy is a fact in the organization plane and a
 * room is its shadow on a system the hub does not own — so the outcome
 * rides back in the body instead, and the operator is told rather than left
 * to discover it weeks later from a gate that never arrived.
 *
 * `no-bridge` is a configuration answer rather than a fault: a hub with no
 * homeserver configured has no rooms for anything, and the assignment is
 * complete without one.
 */
export type RoomOutcome =
  | { status: "provisioned" }
  | { status: "no-bridge" }
  | { status: "failed"; error: string };

/** The sentence to show for an outcome, or null when there is nothing to say. */
export function roomProblem(room: RoomOutcome | undefined): string | null {
  if (!room || room.status !== "failed") return null;
  return `It has no Matrix room yet — provisioning failed: ${room.error}. It will get one when the hub next provisions; the assignment itself stands.`;
}

/**
 * Put a principal in a station — what makes the station dispatchable, and
 * provisions its Matrix room.
 *
 * Throws on 403 when the principal is suspended (a suspension that could be
 * routed around by handing the same agent a station would not be a
 * suspension) and on 404 when either side of the pair no longer exists.
 *
 * Resolves — rather than throwing — when the assignment landed but the room
 * did not. See {@link RoomOutcome}: that is a partial success, and reporting
 * it as a failure would tell the operator to retry something that already
 * happened.
 */
export function assignStationAgent(
  stationId: string,
  principalId: string
): Promise<{ stationId: string; principalId: string; room?: RoomOutcome }> {
  return http(`/api/admin/stations/${encodeURIComponent(stationId)}/agent`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId }),
  });
}

/** Take a station's agent out — it goes back to dispatchable-by-nobody. */
export function unassignStationAgent(
  stationId: string
): Promise<{ stationId: string; principalId: null }> {
  return http(`/api/admin/stations/${encodeURIComponent(stationId)}/agent`, { method: "DELETE" });
}

/**
 * The handle an operator would actually choose, pre-filled from a station
 * key such as `hermes:writer-quill` → `writer-quill`.
 *
 * The part before the colon names the harness, which is not part of an
 * identity anyone types out loud — `charter →
 * decisions/2026-08-30-an-agent-is-a-principal.md` §3 is exactly why an
 * agent's handle no longer carries a plane or harness prefix. A key with no
 * colon at all (unexpected, but not this function's place to refuse) is
 * returned unchanged rather than throwing, since the field stays editable
 * either way.
 */
export function defaultHandleFromStationKey(stationKey: string): string {
  const i = stationKey.indexOf(":");
  return i === -1 ? stationKey : stationKey.slice(i + 1);
}
