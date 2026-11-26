/**
 * The hub's superdial routes, mounted at `/internal/superdial` (master plan C4 and C6).
 *
 *   POST /turns/:turnId/cancel   superdial-agent → hub, bearer SUPERDIAL_AGENT_TOKEN: stop the
 *                                spoken turn it names (the caller hung up mid-turn).
 *
 * Outside `/api/*` because the callers are machines holding shared secrets, not people holding
 * sessions: none of the session auth, CSRF or activity logging there applies. Each secret opens
 * only its own route. Neither is meant to be published on the hub's public hostname; the bearer
 * is what holds if it is.
 */

import { Hono } from "hono";
import type { Calls } from "../services/matrix-as";

export interface SuperdialRouteDeps {
  /** SUPERDIAL_AGENT_TOKEN. Empty: every request is refused. */
  agentToken: string;
  /** SUPERDIAL_MEMBERSHIP_TOKEN. Empty: every request is refused. */
  membershipToken: string;
  /** Null when calls are off (or the Matrix bridge is): a cancel then stops nothing. */
  calls: Pick<Calls, "cancelTurn"> | null;
}

/** Constant-time over equal lengths, so a token cannot be found a character at a time. */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0 || expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

function bearer(header: string | undefined): string {
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

export function createSuperdialRoutes(deps: SuperdialRouteDeps) {
  return new Hono().post("/turns/:turnId/cancel", async (c) => {
    if (!tokenMatches(deps.agentToken, bearer(c.req.header("Authorization")))) {
      return c.json({ errcode: "M_UNKNOWN_TOKEN" }, 401);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const roomId =
      body !== null && typeof body === "object" && "room_id" in body && typeof body.room_id === "string"
        ? body.room_id
        : null;
    if (!roomId) return c.json({ errcode: "M_BAD_JSON", error: "room_id is required" }, 400);
    await deps.calls?.cancelTurn(c.req.param("turnId"), roomId);
    return c.body(null, 204);
  });
}
