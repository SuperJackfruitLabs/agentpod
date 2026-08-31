/**
 * An agent speaking without being spoken to.
 *
 * hermes agents have cron jobs: they report in the morning, they raise things
 * nobody asked about. Bridge mode relays ACP session output, and an ACP session
 * exists only because somebody prompted it — so a scheduled message had nowhere
 * to go, and an agent that used to announce things went quiet. This is the path
 * back, and closing it was the last thing keeping bridge mode short of parity
 * with a harness's own Matrix client.
 *
 * Deliberately **not** an ACP session. There is no conversation, no turn and no
 * transcript to attach: a station is saying something in its own room, as
 * itself. Giving it a session would put a scheduled announcement into the
 * conversation history as though somebody had asked for it.
 *
 * Guarded by the same grant that guards dispatching the agent, because speaking
 * *as* an agent is a strong thing to be able to do: anyone who may not dispatch
 * it must not be able to put words in its mouth.
 */

import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { nodes } from "../db/schema/nodes";
import { getGrant, grantAllowsPrincipal } from "../services/grants";
import { principalForUser, principalHandle } from "../services/principals";
import { isControlPairEnforced } from "../services/control-pair";
import { bridgeUserId } from "../services/matrix-as/names";
import { roomForStation } from "../services/matrix-as/station-room";
import { createLogger } from "../utils/logger";
import type { AuthUser } from "../auth/middleware";

const log = createLogger("station-say");

export interface StationSayDeps {
  domain: string;
  client: {
    sendText(userId: string, roomId: string, body: string): Promise<string | null>;
  };
}

export function createStationSayRoutes(deps: StationSayDeps) {
  return new Hono().post("/stations/:id/matrix/say", async (c) => {
    const user = c.get("user") as AuthUser;

    const [station] = await db
      .select({
        id: stations.id,
        stationKey: stations.stationKey,
        mode: stations.matrixIdentityMode,
        nodeName: nodes.name,
        principalId: stations.principalId,
      })
      .from(stations)
      .innerJoin(nodes, eq(nodes.id, stations.nodeId))
      .where(and(eq(stations.id, c.req.param("id")), eq(stations.userId, user.id)));

    if (!station) return c.json({ error: "Not Found" }, 404);

    const body = (await c.req.json().catch(() => null)) as { body?: unknown } | null;
    const text = typeof body?.body === "string" ? body.body : "";
    if (text.trim() === "") {
      return c.json({ error: "A message needs something in it." }, 400);
    }

    // The same question dispatching asks. Speaking as an agent is speaking AS
    // it, and a grant that does not cover this station does not cover this.
    if (isControlPairEnforced()) {
      // `getGrant` is keyed by principal id now, not the Better Auth user id a
      // session carries — a caller with no principal has no grant to hold and
      // must be refused, not treated as unrestricted.
      const principal = await principalForUser(user.id);
      if (!principal) {
        log.warn("unprompted message refused: no principal for this caller", { userId: user.id });
        return c.json({ error: "You are not permitted to speak as this agent." }, 403);
      }
      const grant = await getGrant(principal.id);
      const allowed = grantAllowsPrincipal(grant, station.principalId);
      if (!allowed) {
        log.warn("unprompted message refused by the control pair", {
          principalId: principal.id,
          node: station.nodeName,
          stationKey: station.stationKey,
        });
        return c.json(
          {
            error:
              "You are not permitted to speak as this agent. Your grant does not cover " +
              `${station.nodeName}/${station.stationKey}.`,
          },
          403
        );
      }
    }

    // A harness-mode station has its own Matrix client and posts its own
    // announcements. Speaking for it as well would double every one of them.
    if (station.mode !== "bridge") {
      return c.json(
        {
          error:
            "This station answers for itself on Matrix, so the bridge does not speak for it. " +
            "Post from its own client, or move it back to bridge mode.",
        },
        409
      );
    }

    // The CURRENT occupant's own room — never a departed occupant's room
    // that merely still sits at this `station_id`. A plain
    // `leftJoin(matrixRooms, stationId)` here was finding 1 of a fix-round
    // review's second pass: it would speak as `station.principalId` into
    // whatever room that unordered join happened to return, which could
    // belong to a predecessor — `@agent_Q` sent into `@agent_P`'s room, a
    // room whose Matrix membership belongs to P. `station-room.ts` is the
    // one place this resolves now.
    const roomId = (await roomForStation(station.id)).room?.roomId ?? null;
    if (!roomId) {
      // Provisioning may simply not have run yet. Saying which thing is missing
      // beats swallowing the message.
      return c.json(
        { error: "This station has no Matrix room yet. Provision its identity first." },
        409
      );
    }

    // A station with no occupying agent has no handle and therefore no mxid to
    // speak as — refused rather than falling back to the retired
    // `(nodeName, stationKey)` form, which would silently reinvent a
    // station-derived identity.
    const handle = station.principalId ? await principalHandle(station.principalId) : null;
    if (!handle) {
      return c.json(
        {
          error:
            "This station has no occupying agent, so there is nobody to speak as here.",
        },
        409
      );
    }

    const agentUser = bridgeUserId(handle, deps.domain);
    const eventId = await deps.client.sendText(agentUser, roomId, text);

    log.info("station spoke unprompted", {
      principalId: user.id,
      stationKey: station.stationKey,
      chars: text.length,
    });

    return c.json({ eventId, roomId, mxid: agentUser });
  });
}
