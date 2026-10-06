/** Explicit, owner-scoped onboarding. Existing assign/move APIs keep their semantics. */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, sql, desc } from "drizzle-orm";
import { tenantScope } from "../db/tenant-scope";
import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { stationSetups } from "../db/schema/station-setup";
import {
  provisionStationNow,
  stationSetupMatrixDomain,
} from "../services/matrix-as/hooks";
import { bridgeUserId } from "../services/matrix-as/names";
import { roomForStation } from "../services/matrix-as/station-room";
import { OrgPlaneError } from "../services/org-plane/client";
import { principalDirectory } from "../services/org-plane/directory";
import {
  abandonPlaneAgent,
  checkPlaneAgent,
  createPlaneAgent,
  grantDispatchTo,
} from "../services/org-plane/agent-placement";
import { humanPrincipalIdForUser, principalHandle } from "../services/principals";
import { createLogger } from "../utils/logger";

const log = createLogger("station-setup");

const inputSchema = z.object({
  requestId: z.string().uuid(),
  agent: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("new"),
      handle: z
        .string()
        .min(1)
        .max(128)
        .regex(/^[a-z0-9.=/-]+$/),
      displayName: z.string().min(1).max(200),
    }),
    z.object({
      kind: z.literal("existing"),
      principalId: z.string().regex(/^prn_[a-f0-9]{20}$/),
    }),
  ]),
  dispatch: z.enum(["me", "none"]),
});
class SetupError extends Error {
  constructor(
    public status: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
const owned = (id: string, userId: string, tenantId: string) =>
  tenantScope(
    stations,
    tenantId,
    eq(stations.id, id),
    eq(stations.userId, userId),
  );
async function matrixStatus(stationId: string) {
  const occupancy = await roomForStation(stationId);
  const [station] = await db
    .select()
    .from(stations)
    .where(eq(stations.id, stationId));
  // Through `principalHandle`, which reads the plane's directory.
  const handle = occupancy.principalId
    ? await principalHandle(occupancy.principalId)
    : null;
  const domain = stationSetupMatrixDomain();
  const [receipt] = await db
    .select()
    .from(stationSetups)
    .where(
      and(
        eq(stationSetups.stationId, stationId),
        eq(stationSetups.principalId, occupancy.principalId ?? ""),
      ),
    )
    .orderBy(desc(stationSetups.createdAt))
    .limit(1);
  return {
    status: !domain
      ? "no-bridge"
      : receipt?.matrixStatus === "failed"
        ? "failed"
        : occupancy.room
          ? "provisioned"
          : "pending",
    error: receipt?.matrixStatus === "failed" ? receipt.matrixError : null,
    address: handle && domain ? bridgeUserId(handle, domain) : null,
    roomId: occupancy.room?.roomId ?? null,
    mode: station?.matrixIdentityMode ?? "bridge",
  };
}
async function provision(stationId: string) {
  const outcome = await provisionStationNow(stationId);
  const occupancy = await roomForStation(stationId);
  await db
    .update(stationSetups)
    .set({
      matrixStatus: outcome.status,
      matrixError: outcome.status === "failed" ? outcome.error : null,
    })
    .where(
      and(
        eq(stationSetups.stationId, stationId),
        eq(stationSetups.principalId, occupancy.principalId ?? ""),
      ),
    );
  const state = await matrixStatus(stationId);
  return outcome.status === "failed"
    ? { ...state, status: "failed", error: outcome.error }
    : state;
}
function conflict(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    (("code" in e && e.code === "23505") || ("cause" in e && conflict(e.cause)))
  );
}

export const stationSetupRouter = new Hono()
  .get("/station-setup/options", async (c) => {
    // The plane's list carries each principal's grant, so this is the directory's cached list
    // and no call per human.
    const all = await principalDirectory().list();
    const placed = new Set(
      (await db.select({ id: stations.principalId }).from(stations)).map((r) => r.id),
    );
    const humans = all.filter((p) => p.kind === "human");
    return c.json({
      agents: all
        .filter((p) => p.kind === "agent" && !p.suspended && !placed.has(p.id))
        .map((a) => ({
          id: a.id,
          handle: a.handle,
          displayName: a.displayName,
          dispatchers: humans
            .filter((h) => h.grant?.mayDispatch.includes(a.id))
            .map((h) => h.handle),
        })),
      matrixDomain: stationSetupMatrixDomain(),
    });
  })
  .get("/stations/:stationId/setup", async (c) => {
    const [station] = await db
      .select()
      .from(stations)
      .where(
        owned(
          c.req.param("stationId"),
          c.get("user").id,
          c.get("user").tenantId,
        ),
      );
    if (!station) return c.json({ error: "Station not found" }, 404);
    return c.json({
      principalId: station.principalId,
      matrix: await matrixStatus(station.id),
    });
  })
  .post(
    "/stations/:stationId/setup",
    zValidator("json", inputSchema),
    async (c) => {
      const input = c.req.valid("json"),
        userId = c.get("user").id,
        stationId = c.req.param("stationId");
      const serialized = JSON.stringify(input);
      // The agent is made (or checked) at the plane BEFORE the transaction: a remote call cannot
      // join it. What the transaction would refuse anyway is checked first, so an ordinary
      // refusal mints nothing; a race past these checks is caught below and the agent made for
      // it is suspended.
      let planeAgent: string | null = null;
      let placedAgent: { id: string; handle: string; displayName: string | null } | null = null;
      let me: string | null = null;
      let fresh = false;
      {
        const [receipt] = await db
          .select({ requestId: stationSetups.requestId })
          .from(stationSetups)
          .where(eq(stationSetups.requestId, input.requestId));
        if (!receipt) {
          const [station] = await db
            .select({ principalId: stations.principalId })
            .from(stations)
            .where(owned(stationId, userId, c.get("user").tenantId));
          if (!station) return c.json({ error: "Station not found" }, 404);
          if (station.principalId)
            return c.json(
              { error: "This station already has an agent. Refresh to see its identity." },
              409,
            );
          if (input.dispatch === "me") {
            me = await humanPrincipalIdForUser(userId);
            if (!me)
              return c.json(
                { error: "Your active operator identity is required to grant dispatch access" },
                403,
              );
          }
          try {
            if (input.agent.kind === "new") {
              planeAgent = await createPlaneAgent({
                handle: input.agent.handle,
                displayName: input.agent.displayName,
                matrixDomain: stationSetupMatrixDomain(),
              });
              placedAgent = {
                id: planeAgent,
                handle: input.agent.handle,
                displayName: input.agent.displayName,
              };
            } else {
              const state = await checkPlaneAgent(input.agent.principalId);
              if (state === "not-found") return c.json({ error: "Agent not found" }, 404);
              if (state === "suspended")
                return c.json({ error: "This agent is suspended" }, 403);
              const agent = (await principalDirectory().principal(input.agent.principalId))!;
              placedAgent = { id: agent.id, handle: agent.handle, displayName: agent.displayName };
            }
          } catch (e) {
            if (!(e instanceof OrgPlaneError)) throw e;
            log.warn("org plane refused an agent placement", { stationId, status: e.status, code: e.code });
            if (e.status === 409)
              return c.json(
                {
                  error:
                    "The handle or assignment is already taken. Refresh and choose an unassigned agent or a different handle.",
                },
                409,
              );
            return c.json({ error: "The organization plane could not create or check this agent" }, 502);
          }
        }
      }
      try {
        const principalId = await db.transaction(async (tx) => {
          // Serializes setup at this station; a stale UI cannot evict its new occupant.
          const [station] = await tx
            .select()
            .from(stations)
            .where(owned(stationId, userId, c.get("user").tenantId))
            .for("update");
          if (!station) throw new SetupError(404, "Station not found");
          const [receipt] = await tx
            .select()
            .from(stationSetups)
            .where(eq(stationSetups.requestId, input.requestId));
          if (receipt) {
            if (
              receipt.stationId !== stationId ||
              receipt.userId !== userId ||
              receipt.input !== serialized
            )
              throw new SetupError(
                409,
                "This setup request was already used with different choices",
              );
            if (station.principalId !== receipt.principalId)
              throw new SetupError(
                409,
                "Station assignment changed after setup; refresh before continuing",
              );
            return receipt.principalId;
          }
          if (station.principalId)
            throw new SetupError(
              409,
              "This station already has an agent. Refresh to see its identity.",
            );
          // Checked at the plane above. A receipt written since (a concurrent retry) was
          // answered before this point; anything else this request did not pre-check lands here.
          if (!placedAgent)
            throw new SetupError(
              409,
              "Station assignment changed after setup; refresh before continuing",
            );
          const id = placedAgent.id;
          if (input.agent.kind === "existing") {
            const [placement] = await tx
              .select({ id: stations.id })
              .from(stations)
              .where(eq(stations.principalId, id));
            if (placement)
              throw new SetupError(
                409,
                "This agent is already assigned elsewhere. Setup will not move it.",
              );
          }
          // The dispatch grant is written at the plane after commit (below).
          await tx
            .update(stations)
            .set({ principalId: id })
            .where(eq(stations.id, stationId));
          await tx.execute(sql`UPDATE matrix_rooms SET principal_id=${id}
          WHERE room_id=(SELECT room_id FROM matrix_rooms WHERE station_id=${stationId} AND principal_id IS NULL ORDER BY created_at ASC,room_id ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM matrix_rooms WHERE principal_id=${id})`);
          await tx
            .insert(stationSetups)
            .values({
              requestId: input.requestId,
              stationId,
              userId,
              tenantId: station.tenantId,
              input: serialized,
              principalId: id,
            });
          fresh = true;
          return id;
        });
        // A concurrent retry's receipt answered this request: the agent made for it is unused.
        if (planeAgent && planeAgent !== principalId) await abandonPlaneAgent(planeAgent);
        planeAgent = null; // settled: placed, or abandoned just now. Nothing below may suspend it.
        if (fresh && me) {
          // Only on the request that placed the agent: a retry answered from the receipt never
          // regrants.
          try {
            await grantDispatchTo(me, principalId);
          } catch (e) {
            if (!(e instanceof OrgPlaneError)) throw e;
            log.warn("agent placed but the org plane did not record the dispatch grant", {
              stationId,
              principalId,
              status: e.status,
              code: e.code,
            });
            return c.json(
              {
                error:
                  "The agent is placed, but the organization plane did not record your dispatch access. Grant it at the organization plane.",
                principalId,
              },
              502,
            );
          }
        }
        return c.json({ principalId, matrix: await provision(stationId) });
      } catch (e) {
        if (planeAgent) await abandonPlaneAgent(planeAgent);
        if (e instanceof SetupError)
          return c.json({ error: e.message }, e.status);
        if (conflict(e))
          return c.json(
            {
              error:
                "The handle or assignment is already taken. Refresh and choose an unassigned agent or a different handle.",
            },
            409,
          );
        throw e;
      }
    },
  )
  .post(
    "/stations/:stationId/setup/matrix",
    zValidator("json", z.object({ principalId: z.string() })),
    async (c) => {
      const stationId = c.req.param("stationId");
      const [station] = await db
        .select()
        .from(stations)
        .where(owned(stationId, c.get("user").id, c.get("user").tenantId));
      if (!station) return c.json({ error: "Station not found" }, 404);
      if (
        !station.principalId ||
        station.principalId !== c.req.valid("json").principalId
      )
        return c.json(
          { error: "Station assignment changed; refresh before retrying" },
          409,
        );
      return c.json({
        principalId: station.principalId,
        matrix: await provision(stationId),
      });
    },
  );
