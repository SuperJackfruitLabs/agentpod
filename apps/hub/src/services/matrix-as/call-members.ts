/**
 * A person's call in an agent's room, noticed from its membership state.
 *
 * The caller publishes `org.matrix.msc3401.call.member` with state key
 * `_{user_id}_{device_id}_m.call` (protocol.md §3); emptying that state is leaving. The hub's
 * appservice receives it like any room event — before this, `handleRoomMessage` dropped every
 * event that was not `m.room.message`, so this is routed ahead of it (`service.ts`).
 *
 * **Only a person's, only in a bridge agent's room.** An agent's own membership (its call device
 * joining) is cut at the transaction route like every `@agent_*` event, and again here. A
 * harness-mode agent is its own Matrix client: calls are not offered there, and a call started in
 * one is refused at the token service, not joined here.
 *
 * Who is in a call is kept in memory. A restart forgets it, which costs nothing: a leave for a
 * room with no record still ends the call (superdial-agent's leave is idempotent), and the next
 * join asks it to join again (so is that).
 */

import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixRooms } from "../../db/schema/matrix";
import { stations } from "../../db/schema/stations";
import { bridgeUserId, isBridgeUser } from "../matrix";
import { principalHandle } from "../../auth/org-plane/principals";
import { createLogger } from "../../utils/logger";
import { CALL_MEMBER_TYPE } from "./call-config";

const log = createLogger("matrix-calls");

/** An agent room, as a call needs it. */
export interface CallRoom {
  roomId: string;
  stationId: string;
  /** The station's owner: who its ACP sessions belong to. */
  stationUserId: string;
  identityMode: string;
  /** The agent's mxid, or null for a station nobody occupies. */
  agentUserId: string | null;
}

export interface CallMemberEvent {
  type: string;
  sender: string;
  room_id?: string;
  state_key?: string;
  content?: Record<string, unknown>;
}

/** One person device's membership: joined (state published) or left (state emptied). */
export interface CallMembership {
  roomId: string;
  sender: string;
  stateKey: string;
  joined: boolean;
}

/**
 * The membership an event states, or null when it is not a person's call membership.
 *
 * The state key must name its sender: `_{sender}_` then a device id, then `_m.call`. A key naming
 * somebody else is refused here whatever the homeserver let through — owning a call in another
 * person's name is the one thing a membership must not do.
 */
export function parseCallMember(event: CallMemberEvent, domain: string): CallMembership | null {
  if (event.type !== CALL_MEMBER_TYPE) return null;
  if (!event.room_id || typeof event.state_key !== "string") return null;
  if (isBridgeUser(event.sender, domain)) return null;
  const prefix = `_${event.sender}_`;
  const key = event.state_key;
  if (!key.startsWith(prefix) || !key.endsWith("_m.call") || key.length <= prefix.length + "_m.call".length) {
    return null;
  }
  const joined = event.content !== undefined && event.content !== null && Object.keys(event.content).length > 0;
  return { roomId: event.room_id, sender: event.sender, stateKey: key, joined };
}

/** The agent room behind a room id, or null for a room the hub holds no station for. */
export async function callRoomFor(roomId: string, domain: string): Promise<CallRoom | null> {
  const [row] = await db
    .select({
      roomId: matrixRooms.roomId,
      stationId: stations.id,
      stationUserId: stations.userId,
      identityMode: stations.matrixIdentityMode,
      principalId: stations.principalId,
    })
    .from(matrixRooms)
    .innerJoin(stations, eq(stations.id, matrixRooms.stationId))
    .where(eq(matrixRooms.roomId, roomId))
    .limit(1);
  if (!row) return null;
  const handle = row.principalId ? await principalHandle(row.principalId) : null;
  return {
    roomId: row.roomId,
    stationId: row.stationId,
    stationUserId: row.stationUserId,
    identityMode: row.identityMode,
    agentUserId: handle ? bridgeUserId(handle, domain) : null,
  };
}

export interface CallWatcherDeps {
  domain: string;
  /** Defaults to `callRoomFor`. */
  roomFor?: (roomId: string) => Promise<CallRoom | null>;
  /** A person joined a call in a bridge agent's room: have the agent join (idempotent). */
  onJoin(room: CallRoom): Promise<void>;
  /** The last person left: have the agent leave (idempotent). */
  onLeave(roomId: string, room: CallRoom): Promise<void>;
}

export function createCallWatcher(deps: CallWatcherDeps) {
  const roomFor = deps.roomFor ?? ((roomId: string) => callRoomFor(roomId, deps.domain));
  /** Per room, the person devices whose membership is published. */
  const members = new Map<string, Set<string>>();

  return {
    async handle(event: CallMemberEvent): Promise<void> {
      const membership = parseCallMember(event, deps.domain);
      if (!membership) return;
      const room = await roomFor(membership.roomId);
      if (!room || !room.agentUserId) return;
      if (room.identityMode !== "bridge") {
        log.info("a call in a harness-mode agent's room; not joined", { roomId: room.roomId });
        return;
      }

      if (membership.joined) {
        let set = members.get(room.roomId);
        if (!set) {
          set = new Set();
          members.set(room.roomId, set);
        }
        set.add(membership.stateKey);
        log.info("a person joined a call in an agent's room", { roomId: room.roomId, agent: room.agentUserId });
        await deps.onJoin(room);
        return;
      }

      const set = members.get(room.roomId);
      set?.delete(membership.stateKey);
      if (set && set.size > 0) return;
      members.delete(room.roomId);
      log.info("the last person left a call in an agent's room", { roomId: room.roomId, agent: room.agentUserId });
      await deps.onLeave(room.roomId, room);
    },
  };
}
