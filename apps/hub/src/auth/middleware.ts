/**
 * Authentication middleware for Hono.
 *
 * The organization plane is the only issuer (contract §1 cutover rule: no dual-accept), and since
 * the hub's own auth tables were dropped (P3 plan, Task 17) it is the only one there is. A caller
 * presents a plane token, or the static API_TOKEN — which is configuration, not an issuer.
 * `AuthUser.id` is the caller's `prn_`.
 */

import { createMiddleware } from "hono/factory";
import type { Context, MiddlewareHandler, Next } from "hono";
import { timingSafeEqual } from "crypto";
import { BOOTSTRAP_TENANT_ID } from "./tenant";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { verifyPlaneBearer } from "./hub-token";
import { authorityFromClaims, type TokenAuthority } from "./caller-authority";

const log = createLogger("auth-middleware");

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }

  const bufferA = Buffer.from(a, "utf-8");
  const bufferB = Buffer.from(b, "utf-8");
  return timingSafeEqual(bufferA, bufferB);
}

// =============================================================================
// Types
// =============================================================================

/**
 * User information stored in context
 */
export interface AuthUser {
  /** The caller's `prn_` (or `config.defaultUserId` for the static API_TOKEN). */
  id: string;
  email?: string;
  name?: string;
  image?: string;
  authType: "api_key" | "org_plane";
  /**
   * The isolation boundary this caller acts in: the tenant mapped to the token's `org` (contract
   * §2 "First sight"), or the bootstrap tenant for the static API_TOKEN. See ./tenant.ts.
   */
  tenantId: string;
  /**
   * What the caller's org-plane token says they may do (contract §2). Absent for the static
   * API_TOKEN. Authorization checks read this through `auth/caller-authority.ts` instead of
   * asking the plane (design §5.7).
   */
  authority?: TokenAuthority;
}

/**
 * Extend Hono context with auth info
 */
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
  }
}

// =============================================================================
// Auth Middleware (Require Authentication)
// =============================================================================

/**
 * Authentication middleware — requires a valid org-plane token or the static API_TOKEN.
 *
 * `?token=` is accepted as well as `Authorization: Bearer`, for the browser's WebSocket and
 * EventSource, which cannot set a header.
 */
export function createAuthMiddleware(deps: { verifyPlane?: typeof verifyPlaneBearer } = {}): MiddlewareHandler {
  const verifyPlane = deps.verifyPlane ?? verifyPlaneBearer;
  return createMiddleware(async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : c.req.query("token");
    if (bearer && safeCompare(bearer, config.auth.token)) {
      c.set("user", { id: config.defaultUserId, authType: "api_key", tenantId: BOOTSTRAP_TENANT_ID });
      return next();
    }
    if (bearer) {
      const r = await verifyPlane(bearer);
      if (r.ok) {
        // This API is for people. A route audited and found correct for an agent opts in on its
        // own (MCP, evidence), from a position where the default was closed.
        if (r.caller.principalKind !== "human") {
          log.warn("Refused a non-human plane token", { kind: r.caller.principalKind });
          return c.json(
            {
              error: "Forbidden",
              message: `This endpoint takes a human principal. That token names a ${r.caller.principalKind}.`,
            },
            403
          );
        }
        c.set("user", {
          id: r.caller.sub,
          ...(r.caller.claims.email ? { email: r.caller.claims.email } : {}),
          authType: "org_plane",
          tenantId: r.caller.tenantId,
          authority: authorityFromClaims(r.caller.claims),
        });
        log.debug("Authenticated via org-plane token", { principal: r.caller.sub, tenantId: r.caller.tenantId });
        return next();
      }
      // Contract §2: an entitlement refusal is never a bare 403.
      if (r.status === 403) return c.json(r.body, 403);
    }
    log.warn("Authentication failed - no valid org-plane token or API key");
    return c.json({ error: "Unauthorized", message: "Valid session or API key required" }, 401);
  });
}

export const authMiddleware = createAuthMiddleware();

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get current user from context (returns undefined if not set or anonymous)
 */
export function getCurrentUser(c: Context): AuthUser | undefined {
  const user = c.get("user");
  if (!user || user.id === "anonymous") {
    return undefined;
  }
  return user;
}

/**
 * Require authenticated user (throws if not authenticated)
 */
export function requireUser(c: Context): AuthUser {
  const user = getCurrentUser(c);
  if (!user) {
    throw new Error("User not authenticated");
  }
  return user;
}
