/**
 * Rooms where several agents work together.
 *
 * The other half of a split the operator drew: a **per-agent room is a DM**,
 * because talking to one agent has exactly one correspondent and 32 of those in
 * a Rooms list is a wall. A **mission has several** — agents and people — so it
 * is an ordinary room. That is also what makes spaces useful here: ordinary
 * rooms can be grouped, and DMs did not need it.
 *
 * `charter` → `strategy/2026-08-12-layer-reference.md` P2 calls these
 * "mission/team rooms".
 */

import { Hono } from "hono";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { matrixMissions, matrixMissionMembers } from "../db/schema/matrix";
import { principalIdentities } from "../db/schema/identities";
import { getGrant, grantAllowsPrincipal } from "../services/grants";
import { principalForUser } from "../services/principals";
import { isControlPairEnforced } from "../services/control-pair";
import { bridgeUserId } from "../services/matrix-as/names";
import { missionAlias } from "../services/matrix-as/missions";
import {
  ensureSpaceRecord,
  GENERAL_MISSIONS_KEY,
  type Space,
} from "../services/matrix-as/spaces";
import { createLogger } from "../utils/logger";
import type { AuthUser } from "../auth/middleware";

const log = createLogger("missions");

export interface MissionDeps {
  domain: string;
  client: {
    ensureRoom(
      alias: string,
      opts: { creator: string; name: string; topic: string; invite?: string; isDirect?: boolean }
    ): Promise<string | null>;
    createSpace(opts: { creator: string; name: string }): Promise<string | null>;
    addSpaceChild(creator: string, spaceRoomId: string, childRoomId: string): Promise<void>;
    invite(asUserId: string, roomId: string, invitee: string): Promise<void>;
  };
}

/**
 * The one space every cross-purpose mission hangs under.
 *
 * A mission that spans purposes belongs to both and to neither, which is what
 * a single shared space is for. Not per-node: a mission spans nodes by design,
 * so filing it under one of them would lie about where the work is.
 */
async function missionsSpace(
  tenantId: string,
  speaker: string,
  owner: string | null,
  deps: MissionDeps
): Promise<Space | null> {
  return ensureSpaceRecord(
    tenantId,
    GENERAL_MISSIONS_KEY,
    "Missions",
    speaker,
    owner,
    deps
  );
}

export function createMissionRoutes(deps: MissionDeps) {
  return new Hono().post("/missions", async (c) => {
    const user = c.get("user") as AuthUser;
    const body = (await c.req.json().catch(() => null)) as
      | { name?: unknown; stationIds?: unknown }
      | null;

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const stationIds = Array.isArray(body?.stationIds)
      ? body.stationIds.filter((s): s is string => typeof s === "string")
      : [];

    if (name === "") return c.json({ error: "A mission needs a name." }, 400);
    if (stationIds.length === 0) {
      // A room with no agents in it is a room, and this bridge is not a chat
      // host.
      return c.json({ error: "A mission needs at least one agent in it." }, 400);
    }

    const members = await db
      .select({
        id: stations.id,
        tenantId: stations.tenantId,
        stationKey: stations.stationKey,
        nodeName: nodes.name,
        principalId: stations.principalId,
      })
      .from(stations)
      .innerJoin(nodes, eq(nodes.id, stations.nodeId))
      .where(and(eq(stations.userId, user.id), inArray(stations.id, stationIds)));

    if (members.length !== stationIds.length) {
      return c.json({ error: "Not Found" }, 404);
    }

    // In the order they were ASKED for, not the order Postgres happened to
    // return. The first member creates the room and speaks for it, so leaving
    // that to row order means the same request picks a different creator on a
    // different day — and the room's creator is visible to everyone in it.
    members.sort((a, b) => stationIds.indexOf(a.id) - stationIds.indexOf(b.id));

    // `getGrant` and `principal_identities` are both keyed by principal id now,
    // never by the Better Auth user id a session carries — resolved once, up
    // front, for the control-pair check below and the Matrix invite further
    // down. A caller with no principal has no grant to hold and no identity to
    // invite, so both must fail closed on it rather than querying a table with
    // an id shaped like the wrong plane's.
    const principal = await principalForUser(user.id);

    // Putting an agent in a room is putting it to work, so the grant that
    // governs dispatching it governs this too — checked for EVERY member before
    // anything is created, because a half-made mission is worse than none.
    if (isControlPairEnforced()) {
      if (!principal) {
        log.warn("mission refused: no principal for this caller", { userId: user.id });
        return c.json(
          { error: "You are not permitted to dispatch every agent in this mission." },
          403
        );
      }
      const grant = await getGrant(principal.id);
      const refused = members.filter((m) => !grantAllowsPrincipal(grant, m.principalId));
      if (refused.length > 0) {
        log.warn("mission refused by the control pair", {
          principalId: principal.id,
          refused: refused.map((m) => `${m.nodeName}/${m.stationKey}`),
        });
        return c.json(
          {
            error:
              "You are not permitted to dispatch every agent in this mission: " +
              refused.map((m) => `${m.nodeName}/${m.stationKey}`).join(", "),
          },
          403
        );
      }
    }

    const alias = missionAlias(name, deps.domain);

    // A repeated name is the same mission. Somebody typing it twice means one
    // room both times, and the unique index on alias is what says so.
    const [existing] = await db
      .select()
      .from(matrixMissions)
      .where(eq(matrixMissions.alias, alias));
    if (existing) {
      return c.json({ id: existing.id, roomId: existing.roomId, alias: existing.alias });
    }

    const tenantId = members[0]!.tenantId;
    // The mission speaks as the first agent in it: an appservice must act as
    // SOME user in its namespace, and a room created by one of its members reads
    // better than one created by a nameless bot.
    const speaker = bridgeUserId(members[0]!.nodeName, members[0]!.stationKey, deps.domain);

    const roomId = await deps.client.ensureRoom(alias, {
      creator: speaker,
      name,
      topic: `Mission: ${name}`,
    });
    if (!roomId) return c.json({ error: "Could not create the mission's room." }, 502);

    // `principal_identities.principal_id` is a `prn_…` value — comparing it
    // against the raw Better Auth `user.id` would find nothing for every
    // caller, silently dropping them from their own mission's invite list.
    const [identity] = principal
      ? await db
          .select({ externalId: principalIdentities.externalId })
          .from(principalIdentities)
          .where(
            and(
              eq(principalIdentities.principalId, principal.id),
              eq(principalIdentities.system, "matrix")
            )
          )
      : [];

    // Every mission goes in the one Missions space. Grouping is by NODE now,
    // and a mission that spans machines — which is most of them, since that is
    // the point of a mission — belongs to all of them and to none. Filing it
    // under one member's node would be picking a member.
    const space = await missionsSpace(
      tenantId,
      speaker,
      identity?.externalId ?? null,
      deps
    );

    // As the SPACE's creator, never as this mission's speaker: `m.space.child`
    // state lives on the space, and a user who merely made one of its rooms is
    // not in it. Doing this as the speaker is what shipped for agent rooms and
    // had the homeserver refuse every edge but the first.
    if (space?.creator) {
      await deps.client.addSpaceChild(space.creator, space.roomId, roomId).catch(() => {});
    }

    const id = `msn_${crypto.randomUUID()}`;
    await db.insert(matrixMissions).values({
      id,
      tenantId,
      userId: user.id,
      name,
      roomId,
      alias,
      spaceRoomId: space?.roomId ?? null,
    });
    await db.insert(matrixMissionMembers).values(
      members.map((m) => ({ missionId: id, stationId: m.id, tenantId: m.tenantId }))
    );

    for (const m of members) {
      const agent = bridgeUserId(m.nodeName, m.stationKey, deps.domain);
      if (agent === speaker) continue; // already in the room, having made it
      await deps.client.invite(speaker, roomId, agent).catch(() => {});
    }

    if (identity) await deps.client.invite(speaker, roomId, identity.externalId).catch(() => {});

    log.info("mission created", { id, name, members: members.length });

    return c.json({ id, roomId, alias, spaceRoomId: space?.roomId ?? null });
  });
}
