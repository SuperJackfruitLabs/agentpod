/**
 * The Application Service's front door.
 *
 * A homeserver pushes events here with no session and no user — only the
 * `hs_token` it was configured with. Everything downstream in the bridge trusts
 * what arrives, so this is the boundary that has to hold.
 *
 * Mounted OUTSIDE `/api/*`, deliberately: those paths carry session auth, CSRF
 * and an activity logger, none of which apply to a homeserver talking to us. The
 * caller here is a machine holding a shared secret.
 *
 * Design: `docs/superpowers/specs/2026-08-16-matrix-application-service-design.md`
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/drizzle";
import { matrixAsTransactions } from "../db/schema/matrix";
import { isBridgeUser } from "../services/matrix-as/names";
import { stationForAgentUserId, stationForAlias } from "../services/matrix-as/stations";
import { recordTransaction } from "../services/matrix-as/health";
import { createLogger } from "../utils/logger";

const log = createLogger("matrix-as");

/** The shape the homeserver pushes. Only what this route reads is named. */
interface MatrixEvent {
  type: string;
  sender: string;
  room_id?: string;
  event_id?: string;
  content?: Record<string, unknown>;
}

export interface MatrixAsDeps {
  /** The token the HOMESERVER presents to us. Empty means unconfigured. */
  hsToken: string;
  /** This homeserver's name, e.g. `id.agentpod.dev`. */
  domain: string;
  /** What to do with an event that survived the gate. */
  onEvent: (event: MatrixEvent) => Promise<void>;
  /** Ephemeral events (typing, receipts) — optional; ignored when absent. */
  onEphemeral?: (event: MatrixEvent) => Promise<void>;
  /**
   * Create the room behind an alias we claim. Called when the homeserver asks
   * about an alias that maps to a station — answering 200 without creating it
   * would send the asker to a room that is not there.
   */
  onProvisionAlias?: (alias: string) => Promise<void>;
}

/**
 * Constant-time-ish comparison, so a wrong token cannot be discovered a
 * character at a time by timing the reply.
 */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length === 0) return false;
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Has this transaction already been applied?
 *
 * Recorded in the database rather than in memory: the homeserver retries what it
 * did not see acknowledged, and a crash mid-transaction is exactly when that
 * happens. Idempotency that forgets on restart forgets when it is needed most,
 * and the symptom is every conversation answered twice.
 *
 * Claimed BEFORE the events are handled. A retry that arrives while the first
 * attempt is still running must not start a second — and the cost of that
 * ordering is that a transaction whose handling dies mid-way is not retried.
 * That is the right trade: a lost message is visible and recoverable, a doubled
 * one is neither.
 */
async function claimTransaction(txnId: string): Promise<boolean> {
  const claimed = await db
    .insert(matrixAsTransactions)
    .values({ txnId })
    .onConflictDoNothing({ target: matrixAsTransactions.txnId })
    .returning({ txnId: matrixAsTransactions.txnId });
  return claimed.length > 0;
}

/** Did the homeserver present the token we were configured with? */
function authorised(c: { req: { header: (n: string) => string | undefined } }, deps: MatrixAsDeps): boolean {
  const presented = (c.req.header("Authorization") ?? "").replace(/^Bearer /, "");
  return tokenMatches(deps.hsToken, presented);
}

export function createMatrixAsRoutes(deps: MatrixAsDeps) {
  return (
    new Hono()
      /**
       * PUT /_matrix/app/v1/transactions/:txnId
       *
       * Always answers `{}` with 200 once authenticated: the homeserver reads a
       * non-2xx as "not delivered" and retries the whole transaction, so a
       * failure inside one event must not be reported as a failure of the push.
       */
      .put("/transactions/:txnId", async (c) => {
        if (!authorised(c, deps)) {
          // No detail in the response: this path is reachable by anyone who can
          // reach the hub, and the only useful answer is "no".
          log.warn("appservice transaction rejected: bad or missing hs_token");
          return c.json({ errcode: "M_FORBIDDEN" }, 403);
        }

        // Recorded before anything else: the fact worth knowing is that the
        // homeserver can reach us, which is true whether or not the events
        // inside are ones we act on.
        recordTransaction();

        const txnId = c.req.param("txnId");

        let body: { events?: MatrixEvent[]; ephemeral?: MatrixEvent[] };
        try {
          body = await c.req.json();
        } catch {
          // Malformed JSON from the homeserver is not something a retry fixes.
          return c.json({}, 200);
        }

        if (!(await claimTransaction(txnId))) {
          log.info("appservice transaction already applied", { txnId });
          return c.json({}, 200);
        }

        for (const event of body.events ?? []) {
          // An Application Service is sent what its own users send. Answering
          // those is the loop that fills a database overnight — cut per EVENT,
          // not per transaction, so one echo cannot silence a real message that
          // arrived beside it.
          if (isBridgeUser(event.sender, deps.domain)) continue;

          try {
            await deps.onEvent(event);
          } catch (err) {
            // The homeserver retries the whole transaction, so an event that
            // always throws would block every event after it, forever.
            log.error("appservice event handler threw", {
              txnId,
              eventId: event.event_id,
              type: event.type,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        for (const event of body.ephemeral ?? []) {
          if (!deps.onEphemeral) break;
          if (isBridgeUser(event.sender ?? "", deps.domain)) continue;
          try {
            await deps.onEphemeral(event);
          } catch (err) {
            log.error("appservice ephemeral handler threw", {
              txnId,
              type: event.type,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return c.json({}, 200);
      })

      /**
       * GET /_matrix/app/v1/users/:userId
       *
       * "Does this user exist?" — asked before anyone may talk to a name in our
       * namespace that has never been seen. 200 makes it exist; 404 means there
       * is no station behind it, which is the honest answer for a name somebody
       * typed hopefully.
       */
      .get("/users/:userId", async (c) => {
        if (!authorised(c, deps)) return c.json({ errcode: "M_FORBIDDEN" }, 403);

        // An agent's user id is built from its occupying principal's handle
        // now, not from `(nodeName, stationKey)` — see `stationForAgentUserId`.
        const userId = decodeURIComponent(c.req.param("userId"));
        const station = await stationForAgentUserId(userId, deps.domain);
        if (!station) return c.json({ errcode: "M_NOT_FOUND" }, 404);

        return c.json({}, 200);
      })

      /**
       * GET /_matrix/app/v1/rooms/:alias
       *
       * "Does this room exist?" — asked when someone tries to resolve an alias
       * in our namespace. The room is created here rather than merely claimed,
       * because a 200 promises the asker somewhere to go.
       */
      .get("/rooms/:alias", async (c) => {
        if (!authorised(c, deps)) return c.json({ errcode: "M_FORBIDDEN" }, 403);

        // Both alias shapes, through the one resolver `onProvisionAlias`
        // uses — fix round 4. This gate used to ask `stationForLocalpart`
        // alone, which knows only the station-derived form: an
        // occupant-derived alias (`bridgeAliasForHandle`, the shape every
        // occupied station's room carries now) was 404'd HERE, before
        // `onProvisionAlias` and its two-shape lookup ever ran. Nothing live
        // broke, because a legacy alias still resolved — but the path that
        // creates a missing room for an agent addressed by its handle could
        // never heal itself.
        const alias = decodeURIComponent(c.req.param("alias"));
        const station = await stationForAlias(alias, deps.domain);
        if (!station) return c.json({ errcode: "M_NOT_FOUND" }, 404);

        if (deps.onProvisionAlias) await deps.onProvisionAlias(alias);
        return c.json({}, 200);
      })

      /**
       * GET /_matrix/app/v1/ping
       *
       * How a homeserver proves it can reach us. Cheap, and it needs the token
       * like everything else: an unauthenticated liveness probe on a public path
       * is a free way to learn a bridge is here.
       */
      .get("/ping", async (c) => {
        if (!authorised(c, deps)) return c.json({ errcode: "M_FORBIDDEN" }, 403);
        return c.json({}, 200);
      })
  );
}
