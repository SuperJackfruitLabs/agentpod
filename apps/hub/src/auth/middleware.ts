/**
 * Better Auth Middleware for Hono
 *
 * Provides session-based authentication middleware that:
 * - Extracts session from cookies
 * - Falls back to API key authentication for backward compatibility
 * - Sets user and session in Hono context
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { timingSafeEqual } from "crypto";
import { auth, type Session, type User } from "./drizzle-auth";
import { BOOTSTRAP_TENANT_ID } from "./tenant";
import { config } from "../config";
import { createLogger } from "../utils/logger";
import { userIdForPrincipal } from "../services/principals";
import { verifyHubToken } from "./hub-token";

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
  id: string;
  email?: string;
  name?: string;
  image?: string;
  authType: "better_auth" | "api_key" | "hub_token";
  /**
   * The isolation boundary this caller acts in.
   *
   * Resolved here, at the same layer that resolves `config.defaultUserId` for
   * the service-auth caller — which is plain configuration and never was a
   * membership lookup either. One tenant exists today, so every authenticated
   * caller gets it; when the Organization plane arrives this becomes a
   * membership lookup and nothing below this layer changes. See ./tenant.ts.
   */
  tenantId: string;
}

/**
 * Extend Hono context with auth info
 */
declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    session: Session | null;
    betterAuthUser: User | null;
  }
}

// =============================================================================
// Session Middleware
// =============================================================================

/**
 * Session middleware - extracts session from request and sets context
 * Does NOT require authentication - just loads session if present
 */
export const sessionMiddleware = createMiddleware(async (c: Context, next: Next) => {
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session) {
      c.set("user", {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? undefined,
        authType: "better_auth",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", session.session);
      c.set("betterAuthUser", session.user);
      log.debug("Session loaded", { userId: session.user.id, email: session.user.email });
    } else {
      // Set a default "anonymous" user when no session
      c.set("user", {
        id: "anonymous",
        authType: "api_key",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", null);
      c.set("betterAuthUser", null);
    }
  } catch (error) {
    log.debug("Session extraction failed", { error });
    c.set("user", {
      id: "anonymous",
      authType: "api_key",
      tenantId: BOOTSTRAP_TENANT_ID,
    });
    c.set("session", null);
    c.set("betterAuthUser", null);
  }

  return next();
});

// =============================================================================
// Auth Middleware (Require Authentication)
// =============================================================================

/**
 * Authentication middleware - requires valid session or API key
 * Use this for protected routes
 */
export const authMiddleware = createMiddleware(async (c: Context, next: Next) => {
  // Check for existing session from sessionMiddleware
  const existingUser = c.get("user");

  if (existingUser && existingUser.id !== "anonymous") {
    return next();
  }

  // Try to get session from Better Auth
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session) {
      c.set("user", {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? undefined,
        authType: "better_auth",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", session.session);
      c.set("betterAuthUser", session.user);
      log.debug("Authenticated via Better Auth session", { userId: session.user.id });
      return next();
    }
  } catch (error) {
    log.debug("Better Auth session check failed", { error });
  }

  // Fall back to Bearer token authentication (from header or query param)
  const authHeader = c.req.header("Authorization");
  const queryToken = c.req.query("token");
  
  const bearerToken = authHeader?.startsWith("Bearer ") 
    ? authHeader.slice(7) 
    : queryToken;

  if (bearerToken) {
    // Check if it's the static API key (backward compatibility)
    if (safeCompare(bearerToken, config.auth.token)) {
      log.debug("Authenticated via API key");
      c.set("user", {
        id: config.defaultUserId,
        authType: "api_key",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", null);
      c.set("betterAuthUser", null);
      return next();
    }
    
    // ── A token this hub issued ──────────────────────────────────────────────
    //
    // The hub is the issuer for the whole suite and, until now, was the one plane that would
    // not read its own tokens: a client finishing the authorization-code flow got a credential
    // that opened exactly one endpoint. This is that asymmetry closed.
    //
    // **Human principals only, and the refusal is explicit.** `mayDispatch` is the authority to
    // ask an agent to work; it was never the authority to operate the fleet. Most routes under
    // this middleware have never had to consider a non-human caller, and widening what a hub
    // token reaches must not silently widen who may hold one. When a route is audited and found
    // correct for an agent, it can opt in — from a position where the default was closed.
    const hubClaims = await verifyHubToken(bearerToken);
    if (hubClaims) {
      if (hubClaims.principalKind !== "human") {
        log.warn("Refused a non-human hub token", { kind: hubClaims.principalKind });
        return c.json(
          {
            error: "Forbidden",
            message:
              `This endpoint takes a human principal. That token names a ${hubClaims.principalKind}.`,
          },
          403
        );
      }

      // Translated to a Better Auth id HERE, once, because everything below resolves on one —
      // `getStation(userId, …)`, `requireLive(userId, …)`. Passing a `prn_` down is the defect
      // that killed every bridge-mode room on 2026-08-31 (#399, #400).
      const userId = await userIdForPrincipal(hubClaims.sub);
      if (!userId) {
        log.warn("Hub token names a principal with no Better Auth identity", { sub: hubClaims.sub });
        return c.json(
          {
            error: "Forbidden",
            message: "That principal has no account on this hub.",
          },
          403
        );
      }

      c.set("user", { id: userId, authType: "hub_token", tenantId: BOOTSTRAP_TENANT_ID });
      c.set("session", null);
      c.set("betterAuthUser", null);
      log.debug("Authenticated via hub-issued token", { principal: hubClaims.sub, userId });
      return next();
    }

    // Try to validate as a Better Auth session token
    try {
      const session = await auth.api.getSession({
        headers: new Headers({ Authorization: `Bearer ${bearerToken}` }),
      });
      
      if (session) {
        c.set("user", {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image ?? undefined,
          authType: "better_auth",
          tenantId: BOOTSTRAP_TENANT_ID,
        });
        c.set("session", session.session);
        c.set("betterAuthUser", session.user);
        log.debug("Authenticated via Bearer token", { userId: session.user.id });
        return next();
      }
    } catch (error) {
      log.debug("Bearer token validation failed", { error });
    }
  }

  // Authentication failed
  log.warn("Authentication failed - no valid session or API key");
  return c.json(
    {
      error: "Unauthorized",
      message: "Valid session or API key required",
    },
    401
  );
});

// =============================================================================
// Optional Auth Middleware
// =============================================================================

/**
 * Optional auth middleware - sets user if authenticated but doesn't require it
 * Use this for routes that work with or without authentication
 */
export const optionalAuthMiddleware = createMiddleware(async (c: Context, next: Next) => {
  // Check for existing session from sessionMiddleware
  const existingUser = c.get("user");

  if (existingUser && existingUser.id !== "anonymous") {
    return next();
  }

  // Try to get session from Better Auth
  try {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (session) {
      c.set("user", {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        image: session.user.image ?? undefined,
        authType: "better_auth",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", session.session);
      c.set("betterAuthUser", session.user);
      return next();
    }
  } catch {
    // Silent failure for optional auth
  }

  // Try API key as fallback
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    if (safeCompare(token, config.auth.token)) {
      c.set("user", {
        id: config.defaultUserId,
        authType: "api_key",
        tenantId: BOOTSTRAP_TENANT_ID,
      });
      c.set("session", null);
      c.set("betterAuthUser", null);
    }
  }

  return next();
});

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

/**
 * Get current session from context
 */
export function getCurrentSession(c: Context): Session | null {
  return c.get("session") ?? null;
}

/**
 * Get full Better Auth user from context
 */
export function getBetterAuthUser(c: Context): User | null {
  return c.get("betterAuthUser") ?? null;
}
