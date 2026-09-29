/**
 * POST/DELETE /_supermessage/v1/live-activity/tokens — the app registering
 * where the fleet Live Activity is pushed (spec A1).
 *
 * Same origin as the push gateway, outside `/api/*`: the caller is the
 * supermessage app holding a Matrix access token, not a console session.
 * The token is checked with the homeserver's `whoami`, and the user id it
 * returns is the only owner a row can have — a body cannot name one.
 *
 * 503 when the push gateway is not configured: without APNs there is nothing
 * to push to these tokens, and storing them would only mislead.
 */

import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LiveActivityTokenRegistration, LiveActivityTokenRemoval } from "@agentpod/contract";

import { createLogger } from "../utils/logger";
import type { FleetService } from "../services/push/fleet/service";

const log = createLogger("live-activity-tokens");

// ─── whoami ──────────────────────────────────────────────────────────────────

export type WhoamiResult =
  | { status: "ok"; userId: string; deviceId?: string }
  | { status: "rejected" }
  | { status: "unreachable" };

export type Whoami = (accessToken: string) => Promise<WhoamiResult>;

/** A successful answer is trusted this long. Short: a revoked token stops working within it. */
export const WHOAMI_TTL_MS = 60_000;
const WHOAMI_CACHE_MAX = 1_000;

/**
 * The homeserver's `GET /_matrix/client/v3/account/whoami`, cached briefly by
 * a hash of the access token — never the token itself. Only a success is
 * cached, so a token issued a moment ago is not refused for a minute.
 */
export function createWhoami(opts: {
  homeserverUrl: string;
  ttlMs?: number;
  now?: () => number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}): Whoami {
  const ttl = opts.ttlMs ?? WHOAMI_TTL_MS;
  const now = opts.now ?? Date.now;
  const doFetch = opts.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const url = `${opts.homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/account/whoami`;
  const cache = new Map<string, { userId: string; deviceId?: string; until: number }>();

  return async (accessToken) => {
    const key = createHash("sha256").update(accessToken).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return { status: "ok", userId: hit.userId, deviceId: hit.deviceId };
    if (hit) cache.delete(key);

    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
      });
    } catch (err) {
      log.warn("homeserver whoami unreachable", { error: err instanceof Error ? err.message : String(err) });
      return { status: "unreachable" };
    }
    if (res.status >= 500) return { status: "unreachable" };
    if (res.status !== 200) return { status: "rejected" };
    const body = (await res.json().catch(() => null)) as { user_id?: unknown; device_id?: unknown } | null;
    if (!body || typeof body.user_id !== "string" || !body.user_id.startsWith("@")) return { status: "rejected" };

    const deviceId = typeof body.device_id === "string" ? body.device_id : undefined;
    if (cache.size >= WHOAMI_CACHE_MAX) {
      for (const [k, v] of cache) if (v.until <= now()) cache.delete(k);
      if (cache.size >= WHOAMI_CACHE_MAX) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, { userId: body.user_id, deviceId, until: now() + ttl });
    return { status: "ok", userId: body.user_id, deviceId };
  };
}

// ─── The routes ──────────────────────────────────────────────────────────────

/** A registration is a few hundred bytes. */
export const TOKENS_BODY_MAX = 4 * 1024;

type Authed = { Variables: { userId: string; deviceId?: string } };

export function createLiveActivityRoutes(deps: { fleet: FleetService | null; whoami: Whoami }) {
  const guard = async (c: Context<Authed>, next: () => Promise<void>) => {
    if (!deps.fleet) return c.json({ errcode: "M_UNRECOGNIZED", error: "push gateway not configured" }, 503);
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return c.json({ errcode: "M_MISSING_TOKEN", error: "missing access token" }, 401);
    const who = await deps.whoami(match[1]!);
    if (who.status === "unreachable") {
      return c.json({ errcode: "M_UNKNOWN", error: "homeserver unreachable" }, 502);
    }
    if (who.status === "rejected") return c.json({ errcode: "M_UNKNOWN_TOKEN", error: "unknown access token" }, 401);
    c.set("userId", who.userId);
    if (who.deviceId) c.set("deviceId", who.deviceId);
    return next();
  };

  const limit = bodyLimit({
    maxSize: TOKENS_BODY_MAX,
    onError: (c) => c.json({ errcode: "M_TOO_LARGE", error: "body too large" }, 413),
  });

  async function json(c: Context<Authed>): Promise<unknown | undefined> {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  }

  return new Hono<Authed>()
    .post("/tokens", guard, limit, async (c) => {
      const parsed = LiveActivityTokenRegistration.safeParse(await json(c));
      if (!parsed.success) return c.json({ errcode: "M_BAD_JSON", error: "not a Live Activity token registration" }, 400);
      const b = parsed.data;
      const userId = c.get("userId");
      const sessionDevice = c.get("deviceId");
      if (sessionDevice && sessionDevice !== b.device_id) {
        // Not refused: the row is still the caller's own. Worth a line, since the
        // app is meant to send its session's device.
        log.warn("Live Activity token registered for a device other than the session's", {
          userId,
          sessionDevice,
          deviceId: b.device_id,
        });
      }
      await deps.fleet!.tokenRegistered({
        userId,
        deviceId: b.device_id,
        kind: b.kind,
        activityId: b.kind === "update" ? b.activity_id! : null,
        token: b.token.toLowerCase(),
        environment: b.environment,
      });
      log.info("Live Activity token registered", {
        userId,
        deviceId: b.device_id,
        kind: b.kind,
        environment: b.environment,
        token: `${b.token.slice(0, 8)}…`,
      });
      return c.body(null, 204);
    })
    .delete("/tokens", guard, limit, async (c) => {
      const parsed = LiveActivityTokenRemoval.safeParse(await json(c));
      if (!parsed.success) return c.json({ errcode: "M_BAD_JSON", error: "not a Live Activity token removal" }, 400);
      const b = parsed.data;
      const removed = await deps.fleet!.tokensRemoved(c.get("userId"), {
        kind: b.kind,
        deviceId: b.device_id,
        ...(b.activity_id ? { activityId: b.activity_id } : {}),
      });
      log.info("Live Activity token removed", { userId: c.get("userId"), deviceId: b.device_id, kind: b.kind, removed });
      return c.body(null, 204);
    });
}
