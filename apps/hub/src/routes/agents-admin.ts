/**
 * Creating an agent, and putting it somewhere.
 *
 * `charter → decisions/2026-08-30-an-agent-is-a-principal.md`: creating an
 * agent is "a deliberate act, not a side effect of a machine appearing" — and
 * until this file, the only way one came into existence was a seed script run
 * by hand. This is the HTTP surface that replaces it: minting the principal,
 * and putting it in a station so it becomes dispatchable.
 *
 * Mounted inside the same admin guard as the rest of `/api/admin`, no
 * exemption carved: minting an identity other systems will address by its
 * handle forever is at least as sensitive as the grants and suspensions that
 * already live there.
 *
 * Two refusals this file exists to get right:
 *
 *   - A handle is what an agent's Matrix address is built from
 *     (`services/matrix-as/names.ts`), and it is immutable once minted. A
 *     handle `clean()` would alter — case, or a character outside its kept
 *     set — must be refused here, not silently registered under a different
 *     address than the one typed. The character class below is deliberately
 *     the same one, kept in sync by hand rather than by import: `clean()` is
 *     private to that module, and duplicating a five-character regex is a
 *     smaller risk than reaching into a module this task does not otherwise
 *     touch.
 *   - Two principals cannot share a handle — `principals_org_handle_idx`
 *     enforces it at the database — and a race between two admins hitting
 *     this endpoint at once must still resolve to one winner and a 409, not
 *     a 500 leaking a constraint name.
 *
 * Assigning a suspended principal to a station is refused for a third reason
 * that belongs to the station side, not the handle side: a suspended agent
 * that can still be handed a station is a suspension that does not suspend.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { createPrincipal, principalById } from "../services/principals";
import { createLogger } from "../utils/logger";

const log = createLogger("agents-admin");

/**
 * The same character class `clean()` in `matrix-as/names.ts` cleans a
 * localpart with. A handle outside it is not rejected there — it is
 * rewritten, quietly, into a different address than the one an admin typed.
 * Refusing it here is what makes the handle actually the address, rather
 * than a suggestion for one.
 */
const ILLEGAL_HANDLE_CHARS = /[^a-z0-9.=/-]/g;

function wouldBeMangled(handle: string): boolean {
  return handle.toLowerCase().replace(ILLEGAL_HANDLE_CHARS, "-") !== handle;
}

/**
 * `postgres`'s `PostgresError` isn't re-exported from its ESM entry point
 * (only its CJS build carries it), so this checks shape rather than
 * `instanceof` — the wire-protocol error code for a unique-violation, which
 * is what `principals_org_handle_idx` raises for a repeated handle. Drizzle
 * wraps the driver's error in its own `DrizzleQueryError`, with the original
 * on `.cause`, so both layers are checked.
 */
function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === code;
}

function isHandleTaken(err: unknown): boolean {
  if (hasCode(err, "23505")) return true;
  const cause = err instanceof Error ? err.cause : undefined;
  return hasCode(cause, "23505");
}

const createAgentBody = z.object({
  handle: z.string().min(1),
  displayName: z.string().min(1).optional(),
});

const assignBody = z.object({
  principalId: z.string(),
});

export const agentsAdminRouter = new Hono()
  /**
   * Mint a new agent principal.
   *
   * 201 with the created principal — the id is the whole point of the call,
   * since nothing else in the fleet can predict a `prn_` id in advance.
   */
  .post("/agents", zValidator("json", createAgentBody), async (c) => {
    const { handle, displayName } = c.req.valid("json");

    if (wouldBeMangled(handle)) {
      return c.json(
        { error: "handle would be altered when built into a Matrix address; choose one clean() leaves unchanged" },
        400
      );
    }

    let id: string;
    try {
      id = await createPrincipal({ kind: "agent", handle, displayName });
    } catch (err) {
      if (isHandleTaken(err)) {
        return c.json({ error: "handle already taken" }, 409);
      }
      throw err;
    }

    const principal = await principalById(id);
    log.info("agent principal created", { id, handle, by: c.get("user")?.id });
    return c.json(
      {
        id,
        kind: principal!.kind,
        handle,
        displayName: displayName ?? null,
        suspendedAt: principal!.suspendedAt,
      },
      201
    );
  })

  /**
   * Assign an agent to a station, which is what makes the station
   * dispatchable — an unoccupied station is a machine, not an agent.
   *
   * Refused for a suspended principal: a suspension that can still be handed
   * a station is a suspension that does not suspend.
   */
  .put("/stations/:stationId/agent", zValidator("json", assignBody), async (c) => {
    const stationId = c.req.param("stationId");
    const { principalId } = c.req.valid("json");

    const [station] = await db.select({ id: stations.id }).from(stations).where(eq(stations.id, stationId));
    if (!station) return c.json({ error: "no such station" }, 404);

    const principal = await principalById(principalId);
    if (!principal) return c.json({ error: "no such principal" }, 404);
    if (principal.suspendedAt) {
      return c.json({ error: "principal is suspended" }, 403);
    }

    await db.update(stations).set({ principalId }).where(eq(stations.id, stationId));

    // `matrix_rooms.principal_id`'s one writer — `charter →
    // decisions/2026-08-30-an-agent-is-a-principal.md`'s whole reason a
    // room's identity comes from a handle rather than a station. Binds this
    // station's own room to this principal EXACTLY ONCE: only when that room
    // exists, has no binding yet, and this principal has no room bound
    // anywhere else. Every later assignment — this principal moving to a
    // different station, or a different principal taking this one — leaves
    // the binding alone, which is what makes the room follow the agent
    // rather than the station: `gates.ts`'s `roomForCard` finds THIS
    // principal's room from wherever it is dispatched next, not a fresh room
    // its new station happens to have. Conditioned on `NOT EXISTS` rather
    // than checked-then-written so two assignments racing each other cannot
    // both decide the room is free and violate `matrix_rooms_principal_idx`.
    await db.execute(sql`
      UPDATE matrix_rooms
      SET principal_id = ${principalId}
      WHERE station_id = ${stationId}
        AND principal_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM matrix_rooms already_bound WHERE already_bound.principal_id = ${principalId}
        )
    `);

    log.info("station assigned", { stationId, principalId, by: c.get("user")?.id });
    return c.json({ stationId, principalId });
  })

  /**
   * Unassign — the station goes back to being nobody's, dispatchable by
   * nobody, exactly the state an unoccupied station is already in.
   */
  .delete("/stations/:stationId/agent", async (c) => {
    const stationId = c.req.param("stationId");

    const [station] = await db.select({ id: stations.id }).from(stations).where(eq(stations.id, stationId));
    if (!station) return c.json({ error: "no such station" }, 404);

    await db.update(stations).set({ principalId: null }).where(eq(stations.id, stationId));
    log.info("station unassigned", { stationId, by: c.get("user")?.id });
    return c.json({ stationId, principalId: null });
  });
