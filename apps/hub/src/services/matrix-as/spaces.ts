/**
 * Filing an agent's room under the machine it runs on.
 *
 * A flat roster is fine at 32 agents and unusable at 200. The grouping is the
 * NODE: it is the thing an operator can point at, it needs no labelling step
 * before a new agent lands somewhere sensible, and it is true by construction
 * rather than by anybody remembering to keep it true.
 *
 * This replaced a purpose-based grouping that lasted a day (migration 0052).
 * `stations.purpose` is still recorded — it is what an agent is FOR, which a
 * machine name cannot say — and is meant to become tags, which can overlap and
 * do not fight a hierarchy the way a second axis of spaces would.
 *
 * The mechanism is a Matrix space per node, and the reason it is worth doing
 * here rather than in the client is that it costs the client nothing:
 * supermessage's rail already scopes its roster by `m.space.child` edges, and
 * Element reads the same hierarchy. One `m.space.child` state event per room is
 * the whole feature.
 *
 * Three rules this module exists to keep:
 *
 *   1. **A station whose space could not be made hangs nowhere.** Not under an
 *      invented `Unsorted` — that is a claim nobody made. It still appears in
 *      All rooms.
 *   2. **A room has at most one parent.** An agent can move between machines,
 *      so filing must remove the old edge as well as add the new one; a room
 *      that only ever gained parents would show up under every node it ever
 *      ran on.
 *   3. **Re-running changes nothing.** Provisioning runs at every boot and on
 *      every adoption, and `space_room_id` is what makes the second run a
 *      no-op instead of a re-write.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { matrixSpaces, matrixRooms } from "../../db/schema/matrix";
import { createLogger } from "../../utils/logger";

const log = createLogger("matrix-spaces");

/** What making a space needs. Split from filing: a caller that only ever
 *  creates one (missions) has no business knowing how to unfile a room. */
export interface SpaceCreateDeps {
  client: {
    createSpace(opts: { creator: string; name: string }): Promise<string | null>;
    invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  };
}

/** What moving a room between spaces needs. */
export interface SpaceFileDeps {
  client: {
    addSpaceChild(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
    removeSpaceChild(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
  };
}

/**
 * How a node reads as a space name.
 *
 * Its own name, unchanged. A machine called `molt-bot` is called that
 * everywhere else an operator looks — the console, `apn`, their ssh config —
 * and prettifying it here would make the space the one place it is spelled
 * differently.
 */
export function spaceNameFor(nodeName: string): string {
  return nodeName.trim();
}

/**
 * The space for `nodeName` in this tenant, creating it the first time.
 *
 * `creator` is the agent whose room is being filed — an appservice must act as
 * some user in its namespace, and the first agent on a node to need its space
 * is as good a creator as any. `owner` is invited so the space appears in their client at
 * all: a space nobody has joined is one the roster rail cannot show, and then
 * the whole feature is invisible.
 *
 * Returns null when the homeserver refused, which leaves the room unfiled
 * rather than failing the provisioning that called it. An agent you can talk to
 * in the wrong part of the roster beats an agent that was never provisioned.
 */
export async function ensureNodeSpace(
  tenantId: string,
  nodeName: string,
  creator: string,
  owner: string | null,
  deps: SpaceCreateDeps
): Promise<Space | null> {
  return ensureSpaceRecord(tenantId, nodeName, spaceNameFor(nodeName), creator, owner, deps);
}

/**
 * A space and the user that can write its child edges.
 *
 * The pair travels together because filing needs both, and the actor is the
 * half that is easy to get wrong: `m.space.child` state lives on the SPACE, so
 * only somebody in the space can write it. Filing as the room's own agent —
 * which is a member of its room and of nothing else — is what shipped, and the
 * homeserver refused every edge but the first.
 */
export interface Space {
  roomId: string;
  /** Null only for a space recorded before the creator was stored. */
  creator: string | null;
}

/**
 * The key under which the one general missions space is remembered.
 *
 * The empty string, and unreachable as a node name: enrolment refuses an empty
 * one (`uniqueNodeName` falls back to "node"). That is what makes this a
 * sentinel rather than a name somebody could collide with by calling a machine
 * "missions".
 *
 * It lives in the same table as the node spaces because it is the same kind of
 * thing — a per-tenant space this deployment made and has to find again.
 * The alternative it replaced was reading the space id off any existing
 * mission row, which stopped being correct the moment some missions hung
 * elsewhere: the next one would have been filed under whichever space that
 * arbitrary row happened to hold.
 */
export const GENERAL_MISSIONS_KEY = "";

/**
 * A per-tenant space, created once and remembered by `key`.
 *
 * See [`ensureNodeSpace`] for the node case and [`GENERAL_MISSIONS_KEY`] for
 * the other one.
 */
export async function ensureSpaceRecord(
  tenantId: string,
  key: string,
  name: string,
  creator: string,
  owner: string | null,
  deps: SpaceCreateDeps
): Promise<Space | null> {
  const [existing] = await db
    .select({ roomId: matrixSpaces.roomId, creator: matrixSpaces.creator })
    .from(matrixSpaces)
    .where(and(eq(matrixSpaces.tenantId, tenantId), eq(matrixSpaces.spaceKey, key)));
  if (existing) return existing;

  const roomId = await deps.client.createSpace({ creator, name }).catch(() => null);
  if (!roomId) {
    log.warn("could not create a space; rooms stay unfiled", { name });
    return null;
  }

  await db
    .insert(matrixSpaces)
    .values({ tenantId, spaceKey: key, roomId, creator })
    .onConflictDoNothing();

  // Without this the space exists and nobody can see it.
  if (owner) await deps.client.invite(creator, roomId, owner).catch(() => {});

  log.info("made a space", { name, roomId, creator });
  return { roomId, creator };
}

/**
 * Put `roomId` under the space its station's node calls for — and take it out
 * of the one it is under now, if that is a different one.
 *
 * `desired` of null means "belongs under nothing" — a station whose node space
 * could not be made, mainly. It still has work to do: the old edge has to go.
 *
 * Every edge is written **as the space's own creator**, never as the room's
 * agent — see [`Space`] for the production failure that rule comes from.
 *
 * Nothing is recorded unless the homeserver accepted it. A filing written on
 * top of a refused edge is worse than no filing at all: the next run sees
 * nothing to do, and the room stays outside the space for good.
 */
export async function fileRoomUnderSpace(
  roomId: string,
  desired: Space | null,
  currentSpaceRoomId: string | null,
  deps: SpaceFileDeps
): Promise<void> {
  if ((desired?.roomId ?? null) === currentSpaceRoomId) return;

  if (currentSpaceRoomId) {
    const [current] = await db
      .select({ creator: matrixSpaces.creator })
      .from(matrixSpaces)
      .where(eq(matrixSpaces.roomId, currentSpaceRoomId));

    if (!current?.creator) {
      log.warn("cannot unfile a room from a space with no known creator", {
        roomId,
        spaceRoomId: currentSpaceRoomId,
      });
      return;
    }

    try {
      await deps.client.removeSpaceChild(current.creator, currentSpaceRoomId, roomId);
    } catch (err) {
      log.warn("could not take a room out of its space; leaving it where it is", {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  if (desired) {
    if (!desired.creator) {
      log.warn("cannot file a room into a space with no known creator", {
        roomId,
        spaceRoomId: desired.roomId,
      });
      return;
    }
    try {
      await deps.client.addSpaceChild(desired.creator, desired.roomId, roomId);
    } catch (err) {
      // Left unrecorded on purpose, so the next provision tries again.
      log.warn("could not file a room into its space", {
        roomId,
        spaceRoomId: desired.roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  await db
    .update(matrixRooms)
    .set({ spaceRoomId: desired?.roomId ?? null })
    .where(eq(matrixRooms.roomId, roomId));

  log.info("re-filed a room", {
    roomId,
    from: currentSpaceRoomId,
    to: desired?.roomId ?? null,
  });
}
