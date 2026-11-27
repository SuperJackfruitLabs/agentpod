/**
 * The hub's superdial routes, mounted at `/internal/superdial` (master plan C4 and C6).
 *
 *   POST /turns/:turnId/cancel   superdial-agent → hub, bearer SUPERDIAL_AGENT_TOKEN: stop the
 *                                spoken turn it names (the caller hung up mid-turn).
 *   POST /membership             SuperExchange → hub, bearer SUPERDIAL_MEMBERSHIP_TOKEN: may this
 *                                person have a LiveKit token for this room?
 *
 * Outside `/api/*` because the callers are machines holding shared secrets, not people holding
 * sessions: none of the session auth, CSRF or activity logging there applies. Each secret opens
 * only its own route. Neither is meant to be published on the hub's public hostname; the bearer
 * is what holds if it is.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Calls } from "../services/matrix-as";
import { createLogger } from "../utils/logger";

const log = createLogger("superdial-routes");

export interface SuperdialRouteDeps {
  /** SUPERDIAL_AGENT_TOKEN. Empty: every request is refused. */
  agentToken: string;
  /** SUPERDIAL_MEMBERSHIP_TOKEN. Empty: every request is refused. */
  membershipToken: string;
  /** Null when calls are off (or the Matrix bridge is): a cancel then stops nothing. */
  calls: Pick<Calls, "cancelTurn" | "membership"> | null;
}

/**
 * Constant time whatever the lengths: both sides are hashed to 32 bytes and those compared, so a
 * token can be found neither a character at a time nor by its length. An empty (unset) token
 * matches nothing.
 */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0) return false;
  return timingSafeEqual(sha256(expected), sha256(presented));
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/** A string field of a JSON body, or null. */
function field(body: unknown, name: string): string | null {
  if (body === null || typeof body !== "object" || !(name in body)) return null;
  const value: unknown = Reflect.get(body, name);
  return typeof value === "string" && value !== "" ? value : null;
}

export function createSuperdialRoutes(deps: SuperdialRouteDeps) {
  return new Hono()
    .post("/membership", async (c) => {
      if (!tokenMatches(deps.membershipToken, bearer(c.req.header("Authorization")))) {
        return c.json({ errcode: "M_UNKNOWN_TOKEN" }, 401);
      }
      const body: unknown = await c.req.json().catch(() => null);
      const userId = field(body, "user_id");
      const roomId = field(body, "room_id");
      if (!userId || !roomId) return c.json({ errcode: "M_BAD_JSON", error: "user_id and room_id are required" }, 400);
      if (!deps.calls) return c.json({ allowed: false, reason: "calls_disabled" }, 200);
      try {
        return c.json(await deps.calls.membership({ userId, roomId }), 200);
      } catch (err) {
        // Not knowing is said as not knowing: the token service refuses, and nobody is told a
        // person is not in a room the hub could not ask about.
        log.warn("the call membership check could not be answered", {
          roomId,
          error: err instanceof Error ? err.message : String(err),
        });
        return c.json({ errcode: "M_UNAVAILABLE", error: "membership could not be checked" }, 503);
      }
    })
    .post("/turns/:turnId/cancel", async (c) => {
      if (!tokenMatches(deps.agentToken, bearer(c.req.header("Authorization")))) {
        return c.json({ errcode: "M_UNKNOWN_TOKEN" }, 401);
      }
      const roomId = field(await c.req.json().catch(() => null), "room_id");
      if (!roomId) return c.json({ errcode: "M_BAD_JSON", error: "room_id is required" }, 400);
      await deps.calls?.cancelTurn(c.req.param("turnId"), roomId);
      return c.body(null, 204);
    });
}
