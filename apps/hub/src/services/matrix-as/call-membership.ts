/**
 * C4: the membership check SuperExchange's token service asks before it mints a LiveKit token.
 *
 * "Is this person joined to this room, and is it a bridge agent's room?" The hub knows both, and
 * SuperExchange cannot see agent rooms. Membership is read live from the homeserver, as the
 * agent (a member of its own room), never from a cache: a person removed from the room must not
 * keep getting tokens for it. A homeserver that cannot answer is an error the route reports as
 * such — never an allow, and never a `not_member` it does not know to be true.
 */

import type { CallRoom } from "./call-members";
import { pathSegment } from "./call-agent-client";

export type MembershipRefusal = "not_member" | "not_agent_room" | "harness_mode" | "calls_disabled";

export type MembershipAnswer =
  | { allowed: true; agent_user_id: string; station_id: string }
  | { allowed: false; reason: MembershipRefusal };

export interface MembershipDeps {
  /** Whether calls are on at all. */
  enabled: boolean;
  roomFor(roomId: string): Promise<CallRoom | null>;
  /** `userId`'s `membership` in `roomId`, read as `asUser`; null when there is none. */
  membershipOf(asUser: string, roomId: string, userId: string): Promise<string | null>;
}

export async function checkCallMembership(
  input: { userId: string; roomId: string },
  deps: MembershipDeps,
): Promise<MembershipAnswer> {
  if (!deps.enabled) return { allowed: false, reason: "calls_disabled" };
  const room = await deps.roomFor(input.roomId);
  if (!room || !room.agentUserId) return { allowed: false, reason: "not_agent_room" };
  if (room.identityMode !== "bridge") return { allowed: false, reason: "harness_mode" };
  const membership = await deps.membershipOf(room.agentUserId, room.roomId, input.userId);
  if (membership !== "join") return { allowed: false, reason: "not_member" };
  return { allowed: true, agent_user_id: room.agentUserId, station_id: room.stationId };
}

/**
 * Read a member state event through the appservice, impersonating `asUser`.
 *
 * 404 is the one failure that is an answer — the homeserver holds no member event for that user
 * in that room. Every other non-200 throws.
 */
export function createMembershipReader(deps: {
  homeserverUrl: string;
  asToken: string;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const doFetch = deps.fetch ?? fetch;
  return async function membershipOf(asUser: string, roomId: string, userId: string): Promise<string | null> {
    const url =
      `${deps.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/rooms/${pathSegment(roomId)}` +
      `/state/m.room.member/${pathSegment(userId)}?user_id=${pathSegment(asUser)}`;
    const res = await doFetch(url, { method: "GET", headers: { Authorization: `Bearer ${deps.asToken}` } });
    if (res.status === 404) return null;
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const errcode = body !== null && typeof body === "object" && "errcode" in body ? String(body.errcode) : "";
      throw new Error(`matrix member state for ${userId} in ${roomId} failed: ${res.status} ${errcode}`.trim());
    }
    return body !== null && typeof body === "object" && "membership" in body && typeof body.membership === "string"
      ? body.membership
      : null;
  };
}
