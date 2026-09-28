/**
 * POST /_matrix/push/v1/notify — the Matrix Push Gateway API.
 *
 * The homeserver (tuwunel) calls this for every event that should reach a
 * phone. The spec gives the call no authentication, so the route is the whole
 * defence: a capped body, a strict schema, an allowlist of app ids and a rate
 * limit per pushkey (`services/push/gateway.ts`). It answers
 * `{rejected: [pushkey…]}`, which is how the homeserver learns a device is gone
 * and deletes its pusher.
 *
 * 404 when the gateway is not configured, the same way an unconfigured Matrix
 * bridge answers a homeserver.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import { NotifyRequest, type PushGateway } from "../services/push/gateway";

/** A notify for twenty devices with every optional field is a few KB. */
export const NOTIFY_BODY_MAX = 64 * 1024;

export function createMatrixPushRoutes(gateway: PushGateway | null) {
  return new Hono().post(
    "/notify",
    async (c, next) => {
      if (!gateway) return c.json({ errcode: "M_UNRECOGNIZED", error: "push gateway not configured" }, 404);
      return next();
    },
    bodyLimit({
      maxSize: NOTIFY_BODY_MAX,
      onError: (c) => c.json({ errcode: "M_TOO_LARGE", error: "notification too large" }, 413),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ errcode: "M_NOT_JSON", error: "body is not JSON" }, 400);
      }
      const parsed = NotifyRequest.safeParse(raw);
      if (!parsed.success) {
        return c.json({ errcode: "M_BAD_JSON", error: "not a push gateway notification" }, 400);
      }
      const { rejected } = await gateway!.notify(parsed.data.notification);
      return c.json({ rejected }, 200);
    }
  );
}
