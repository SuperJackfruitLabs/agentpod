import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { createLogger } from "../utils/logger";

const log = createLogger("rate-limit");

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60_000);

const LIMITS = {
  auth: { requests: 60, windowMs: 60_000 },       // 60 auth requests per minute
  api: { requests: 600, windowMs: 60_000 },       // 600 API requests per minute
  sse: { requests: 60, windowMs: 60_000 },        // 60 SSE connections per minute
} as const;

function getClientIdentifier(c: Context): string {
  const user = c.get("user");
  if (user && user.id !== "anonymous") {
    return `user:${user.id}`;
  }

  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

/**
 * The station-token exchange: `POST /api/nodes/:nodeId/stations/:stationId/token`.
 *
 * It is auth traffic that does not live under `/api/auth`. A node presents
 * `<nodeId>:<nodeSecret>` to it (station-token.ts), so it is a
 * credential-guessing surface exactly like a sign-in — and because a node
 * holds no session it sits outside the auth middleware chain by design, which
 * is what kept the prefix above from catching it. Left in the generic bucket
 * it would allow ten times the attempts per minute the sign-in route allows.
 */
const STATION_TOKEN_EXCHANGE = /^\/api\/nodes\/[^/]+\/stations\/[^/]+\/token$/;

export function getLimitType(path: string): keyof typeof LIMITS {
  if (path.startsWith("/api/auth")) return "auth";
  if (STATION_TOKEN_EXCHANGE.test(path)) return "auth";
  if (path.includes("/event") || path.includes("/stream")) return "sse";
  return "api";
}

function checkRateLimit(
  identifier: string,
  limitType: keyof typeof LIMITS
): { allowed: boolean; remaining: number; resetAt: number } {
  const { requests, windowMs } = LIMITS[limitType];
  const key = `${limitType}:${identifier}`;
  const now = Date.now();

  let entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, requests - entry.count);
  const allowed = entry.count <= requests;

  return { allowed, remaining, resetAt: entry.resetAt };
}

export const rateLimitMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const identifier = getClientIdentifier(c);
  const limitType = getLimitType(c.req.path);
  const { allowed, remaining, resetAt } = checkRateLimit(identifier, limitType);

  c.header("X-RateLimit-Limit", String(LIMITS[limitType].requests));
  c.header("X-RateLimit-Remaining", String(remaining));
  c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

  if (!allowed) {
    const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
    c.header("Retry-After", String(retryAfter));

    log.warn("Rate limit exceeded", {
      identifier,
      limitType,
      path: c.req.path,
    });

    return c.json(
      {
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
        retryAfter,
      },
      429
    );
  }

  return next();
});

export const strictRateLimitMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const identifier = getClientIdentifier(c);
  const key = `strict:${identifier}`;
  const now = Date.now();
  const windowMs = 300_000;
  const maxRequests = 3;

  let entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count++;

  if (entry.count > maxRequests) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    c.header("Retry-After", String(retryAfter));

    log.warn("Strict rate limit exceeded", {
      identifier,
      path: c.req.path,
    });

    return c.json(
      {
        error: "Too Many Requests",
        message: "Too many attempts. Please wait before trying again.",
        retryAfter,
      },
      429
    );
  }

  return next();
});
