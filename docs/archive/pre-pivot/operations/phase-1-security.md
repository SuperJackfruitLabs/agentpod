# Phase 1: Security Hardening

**Priority**: Critical  
**Estimated Time**: 4-5 hours  
**Prerequisites**: None

This phase addresses all security vulnerabilities identified in the production readiness assessment.

## Overview

| Task | File | Severity | Time |
|------|------|----------|------|
| 1.1 Security Headers | New middleware | High | 30 min |
| 1.2 Rate Limiting | New middleware | Critical | 1 hr |
| 1.3 Timing-Safe Comparison | Auth middleware | High | 15 min |
| 1.4 Config Validation | New utility + config | Critical | 1 hr |
| 1.5 Global Error Handler | index.ts | High | 30 min |
| 1.6 CSRF Protection | New middleware | Medium | 45 min |

---

## 1.1 Security Headers Middleware

**File**: `apps/api/src/middleware/security-headers.ts`

### Purpose
Add HTTP security headers to all responses to prevent common web vulnerabilities.

### Implementation

```typescript
/**
 * Security Headers Middleware
 * 
 * Adds security-related HTTP headers to all responses.
 * Based on OWASP recommendations and helmet.js defaults.
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { config } from "../config";

export const securityHeadersMiddleware = createMiddleware(async (c: Context, next: Next) => {
  await next();

  // Prevent MIME type sniffing
  c.header("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking
  c.header("X-Frame-Options", "DENY");

  // Enable XSS filter in older browsers
  c.header("X-XSS-Protection", "1; mode=block");

  // Control referrer information
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Disable browser features we don't need
  c.header(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
  );

  // Content Security Policy (adjust based on your frontend needs)
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
  );

  // HSTS (only in production with TLS)
  if (config.nodeEnv === "production" && config.traefik.tls) {
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }

  // Prevent caching of sensitive responses
  if (c.req.path.startsWith("/api/auth")) {
    c.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
    c.header("Pragma", "no-cache");
  }
});
```

### Integration

Add to `apps/api/src/index.ts` after CORS middleware:

```typescript
import { securityHeadersMiddleware } from './middleware/security-headers.ts';

const app = new Hono()
  .use('*', logger())
  .use('*', cors({ /* existing config */ }))
  .use('*', securityHeadersMiddleware)  // Add this line
  // ... rest of routes
```

---

## 1.2 Rate Limiting Middleware

**File**: `apps/api/src/middleware/rate-limit.ts`

### Purpose
Protect against brute-force attacks, DoS, and API abuse.

### Implementation

```typescript
/**
 * Rate Limiting Middleware
 * 
 * Implements tiered rate limiting:
 * - Auth endpoints: 5 req/min (brute-force protection)
 * - General API: 100 req/min (abuse prevention)
 * - SSE/streaming: 10 connections per user
 * 
 * Uses in-memory storage (suitable for single VPS).
 * For multi-instance deployment, replace with Redis.
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { createLogger } from "../utils/logger";

const log = createLogger("rate-limit");

// In-memory store for rate limiting
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) {
      store.delete(key);
    }
  }
}, 60_000);

// Rate limit configurations
const LIMITS = {
  auth: { requests: 5, windowMs: 60_000 },      // 5 req/min for auth
  api: { requests: 100, windowMs: 60_000 },     // 100 req/min for API
  sse: { requests: 10, windowMs: 60_000 },      // 10 SSE connections
} as const;

function getClientIdentifier(c: Context): string {
  // Try to get user ID from context (if authenticated)
  const user = c.get("user");
  if (user && user.id !== "anonymous") {
    return `user:${user.id}`;
  }

  // Fall back to IP address
  const forwarded = c.req.header("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

function getLimitType(path: string): keyof typeof LIMITS {
  if (path.startsWith("/api/auth")) return "auth";
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

  // Create new entry if none exists or window expired
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
    store.set(key, entry);
  }

  entry.count++;
  const remaining = Math.max(0, requests - entry.count);
  const allowed = entry.count <= requests;

  return { allowed, remaining, resetAt: entry.resetAt };
}

/**
 * Rate limiting middleware
 */
export const rateLimitMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const identifier = getClientIdentifier(c);
  const limitType = getLimitType(c.req.path);
  const { allowed, remaining, resetAt } = checkRateLimit(identifier, limitType);

  // Set rate limit headers
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

/**
 * Stricter rate limit for sensitive operations (password reset, etc.)
 */
export const strictRateLimitMiddleware = createMiddleware(async (c: Context, next: Next) => {
  const identifier = getClientIdentifier(c);
  const key = `strict:${identifier}`;
  const now = Date.now();
  const windowMs = 300_000; // 5 minutes
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
```

### Integration

Add to `apps/api/src/index.ts`:

```typescript
import { rateLimitMiddleware, strictRateLimitMiddleware } from './middleware/rate-limit.ts';

const app = new Hono()
  .use('*', logger())
  .use('*', cors({ /* existing config */ }))
  .use('*', securityHeadersMiddleware)
  .use('*', rateLimitMiddleware)  // Add global rate limiting
  // ... health routes (no auth)
  // For auth routes, add strict limiting:
  .use('/api/auth/sign-in/*', strictRateLimitMiddleware)
  .use('/api/auth/sign-up/*', strictRateLimitMiddleware)
  // ... rest of routes
```

---

## 1.3 Timing-Safe Token Comparison

**File**: `apps/api/src/auth/middleware.ts`

### Problem
Current implementation uses `===` for token comparison, which is vulnerable to timing attacks.

### Current Code (Line 132)
```typescript
if (token === config.auth.token) {
```

### Fixed Code
```typescript
import { timingSafeEqual } from "crypto";

// Helper function for timing-safe string comparison
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do the comparison to maintain constant time
    // but we know it will fail
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  
  const bufferA = Buffer.from(a, "utf-8");
  const bufferB = Buffer.from(b, "utf-8");
  return timingSafeEqual(bufferA, bufferB);
}

// In authMiddleware, replace line 132:
if (safeCompare(token, config.auth.token)) {
```

### Full Updated Section

```typescript
// Fall back to API key authentication (backward compatibility)
const authHeader = c.req.header("Authorization");

if (authHeader?.startsWith("Bearer ")) {
  const token = authHeader.slice(7);

  if (safeCompare(token, config.auth.token)) {
    log.debug("Authenticated via API key");
    c.set("user", {
      id: config.defaultUserId,
      authType: "api_key",
    });
    c.set("session", null);
    c.set("betterAuthUser", null);
    return next();
  }
}
```

---

## 1.4 Configuration Validation

### File 1: `apps/api/src/utils/validate-config.ts`

```typescript
/**
 * Configuration Validation
 * 
 * Validates environment configuration at startup.
 * Fails fast with clear error messages if misconfigured.
 */

import { config } from "../config";

interface ValidationError {
  field: string;
  message: string;
}

/**
 * Check if a string has sufficient entropy (not a simple pattern)
 */
function hasMinimumEntropy(value: string, minLength: number = 32): boolean {
  if (value.length < minLength) return false;
  
  // Check for simple patterns
  const simplePatterns = [
    /^(.)\1+$/,                    // All same character
    /^(012|123|234|345|456|567|678|789|890)+$/,  // Sequential numbers
    /^(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)+$/i,  // Sequential letters
  ];
  
  for (const pattern of simplePatterns) {
    if (pattern.test(value)) return false;
  }
  
  // Check character variety (at least 3 different character types)
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasNumber = /[0-9]/.test(value);
  const hasSpecial = /[^a-zA-Z0-9]/.test(value);
  
  const variety = [hasLower, hasUpper, hasNumber, hasSpecial].filter(Boolean).length;
  return variety >= 2;
}

/**
 * Validate configuration for production readiness
 */
export function validateConfig(): void {
  const errors: ValidationError[] = [];
  const isProduction = config.nodeEnv === "production";

  // ==========================================================================
  // Critical: Authentication Secrets
  // ==========================================================================

  // API Token
  const devTokenPattern = /^dev-|change-in-production|example|test|dummy/i;
  if (devTokenPattern.test(config.auth.token)) {
    if (isProduction) {
      errors.push({
        field: "API_TOKEN",
        message: "Production API token cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      console.warn("⚠️  WARNING: Using development API token. Change before production!");
    }
  }

  // Session Secret
  if (devTokenPattern.test(config.betterAuth.session.secret)) {
    if (isProduction) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Production session secret cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      console.warn("⚠️  WARNING: Using development session secret. Change before production!");
    }
  }

  // Encryption Key
  if (config.encryption.key.length !== 32) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: `Encryption key must be exactly 32 characters. Current length: ${config.encryption.key.length}`,
    });
  }
  
  if (devTokenPattern.test(config.encryption.key)) {
    if (isProduction) {
      errors.push({
        field: "ENCRYPTION_KEY",
        message: "Production encryption key cannot contain dev/test patterns.",
      });
    } else {
      console.warn("⚠️  WARNING: Using development encryption key. Change before production!");
    }
  }

  if (isProduction && !hasMinimumEntropy(config.encryption.key, 32)) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: "Encryption key has insufficient entropy. Use a cryptographically random value.",
    });
  }

  // ==========================================================================
  // Production-Only Checks
  // ==========================================================================

  if (isProduction) {
    // Database URL should not use default password
    if (config.database.path.includes("agentpod-dev-password")) {
      errors.push({
        field: "DATABASE_URL",
        message: "Production database cannot use default dev password.",
      });
    }

    // TLS should be enabled in production
    if (!config.traefik.tls) {
      console.warn("⚠️  WARNING: TLS is disabled. Enable for production deployment!");
    }

    // Session secret entropy
    if (!hasMinimumEntropy(config.betterAuth.session.secret, 32)) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Session secret has insufficient entropy. Generate with: openssl rand -base64 32",
      });
    }
  }

  // ==========================================================================
  // Fail Fast on Errors
  // ==========================================================================

  if (errors.length > 0) {
    console.error("\n❌ CONFIGURATION VALIDATION FAILED\n");
    console.error("The following configuration errors must be fixed:\n");
    
    for (const error of errors) {
      console.error(`  • ${error.field}: ${error.message}`);
    }
    
    console.error("\n");
    console.error("Environment: " + config.nodeEnv);
    console.error("\nFor production deployment, ensure all secrets are properly configured.");
    console.error("See: docs/production-readiness/phase-1-security.md\n");
    
    process.exit(1);
  }

  console.log("✅ Configuration validation passed");
}
```

### File 2: Update `apps/api/src/config.ts`

Remove default values for critical secrets in production:

```typescript
// Before (line 41):
token: getEnv('API_TOKEN', 'dev-token-change-in-production'),

// After:
token: getEnv('API_TOKEN', process.env.NODE_ENV === 'production' ? undefined : 'dev-token-change-in-production'),

// Apply same pattern to:
// - ENCRYPTION_KEY (line 48)
// - BETTER_AUTH_SECRET (line 119)
```

### Integration

Update `apps/api/src/index.ts` to validate config on startup:

```typescript
import { validateConfig } from './utils/validate-config.ts';

// Validate configuration first
validateConfig();

// Then initialize database
console.log('Initializing database...');
await initDatabase();
```

---

## 1.5 Global Error Handler

**File**: `apps/api/src/index.ts`

### Purpose
Prevent leaking internal error details to clients while ensuring all errors are logged.

### Implementation

Add after creating the Hono app, before routes:

```typescript
import { createLogger } from './utils/logger.ts';

const errorLogger = createLogger('error-handler');

// Global error handler
app.onError((err, c) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  const isProduction = config.nodeEnv === 'production';

  // Log full error details
  errorLogger.error('Unhandled error', {
    requestId,
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    userId: c.get('user')?.id,
  });

  // Determine status code
  let status = 500;
  if ('status' in err && typeof err.status === 'number') {
    status = err.status;
  }

  // Return sanitized response
  return c.json(
    {
      error: isProduction ? 'Internal Server Error' : err.name,
      message: isProduction ? 'An unexpected error occurred' : err.message,
      requestId,
      ...(isProduction ? {} : { stack: err.stack }),
    },
    status as any
  );
});

// 404 handler for unmatched routes
app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});
```

---

## 1.6 CSRF Protection

**File**: `apps/api/src/middleware/csrf.ts`

### Purpose
Protect against Cross-Site Request Forgery attacks for cookie-based authentication.

### Implementation

```typescript
/**
 * CSRF Protection Middleware
 * 
 * Validates Origin and Referer headers for state-changing requests.
 * Works alongside SameSite=Strict cookies for defense in depth.
 */

import { createMiddleware } from "hono/factory";
import type { Context, Next } from "hono";
import { config } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("csrf");

// Methods that change state
const STATE_CHANGING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

// Allowed origins (add your production domains)
function getAllowedOrigins(): string[] {
  const origins = [
    "http://localhost:1420",    // Tauri dev
    "http://localhost:5173",    // Vite dev
    "tauri://localhost",        // Tauri production
    config.publicUrl,
  ];

  // Add custom domain if configured
  if (config.domain.base !== "localhost") {
    origins.push(`${config.domain.protocol}://${config.domain.base}`);
    origins.push(`${config.domain.protocol}://api.${config.domain.base}`);
  }

  return origins.filter(Boolean);
}

/**
 * Validate origin header against allowed origins
 */
function isValidOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  
  const allowed = getAllowedOrigins();
  return allowed.some(allowedOrigin => {
    // Exact match
    if (origin === allowedOrigin) return true;
    
    // Handle tauri:// scheme
    if (origin.startsWith("tauri://")) return true;
    
    return false;
  });
}

/**
 * CSRF protection middleware
 */
export const csrfMiddleware = createMiddleware(async (c: Context, next: Next) => {
  // Skip for safe methods
  if (!STATE_CHANGING_METHODS.includes(c.req.method)) {
    return next();
  }

  // Skip for API key auth (not cookie-based)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return next();
  }

  // Get Origin header (preferred) or Referer (fallback)
  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");

  // For cookie-based auth, require valid Origin or Referer
  if (origin) {
    if (!isValidOrigin(origin)) {
      log.warn("CSRF check failed: invalid origin", {
        origin,
        path: c.req.path,
        allowed: getAllowedOrigins(),
      });
      
      return c.json(
        {
          error: "Forbidden",
          message: "Invalid request origin",
        },
        403
      );
    }
  } else if (referer) {
    // Extract origin from referer
    try {
      const refererUrl = new URL(referer);
      const refererOrigin = refererUrl.origin;
      
      if (!isValidOrigin(refererOrigin)) {
        log.warn("CSRF check failed: invalid referer", {
          referer,
          path: c.req.path,
        });
        
        return c.json(
          {
            error: "Forbidden",
            message: "Invalid request origin",
          },
          403
        );
      }
    } catch {
      log.warn("CSRF check failed: malformed referer", { referer });
      return c.json(
        {
          error: "Forbidden",
          message: "Invalid request origin",
        },
        403
      );
    }
  } else {
    // No Origin or Referer header - reject for cookie auth
    // This could be a direct API call without browser
    const hasCookie = c.req.header("Cookie")?.includes("better-auth");
    
    if (hasCookie) {
      log.warn("CSRF check failed: missing origin/referer with cookie", {
        path: c.req.path,
      });
      
      return c.json(
        {
          error: "Forbidden",
          message: "Request origin required",
        },
        403
      );
    }
  }

  return next();
});
```

### Integration

Add to `apps/api/src/index.ts` after auth middleware:

```typescript
import { csrfMiddleware } from './middleware/csrf.ts';

// After auth middleware, before routes
.use('/api/*', authMiddleware)
.use('/api/*', csrfMiddleware)  // Add CSRF protection
.use('/api/*', activityLoggerMiddleware)
```

---

## Environment Variables

Add to `.env.example`:

```bash
# =============================================================================
# SECURITY CONFIGURATION (REQUIRED FOR PRODUCTION)
# =============================================================================

# API token for mobile app authentication
# Generate with: openssl rand -base64 32
# REQUIRED in production (no default)
API_TOKEN=dev-token-change-in-production

# Session secret for Better Auth cookie signing
# Generate with: openssl rand -base64 32
# REQUIRED in production (no default)
BETTER_AUTH_SECRET=dev-session-secret-change-in-production

# Encryption key for storing provider API keys
# Must be exactly 32 characters
# Generate with: openssl rand -base64 24 | head -c 32
# REQUIRED in production (no default)
ENCRYPTION_KEY=dev-encryption-key-32-bytes-long!
```

---

## Testing Security Changes

### 1. Rate Limiting Test

```bash
# Test auth rate limiting (should fail after 5 requests)
for i in {1..10}; do
  curl -X POST http://api.localhost/api/auth/sign-in/email \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}' \
    -w "\nStatus: %{http_code}\n"
  sleep 0.1
done
```

### 2. Security Headers Test

```bash
curl -I http://api.localhost/health

# Should see:
# X-Content-Type-Options: nosniff
# X-Frame-Options: DENY
# X-XSS-Protection: 1; mode=block
# Referrer-Policy: strict-origin-when-cross-origin
```

### 3. CSRF Test

```bash
# Should fail - no Origin header with cookie
curl -X POST http://api.localhost/api/sandboxes \
  -H "Cookie: better-auth.session_token=xxx" \
  -H "Content-Type: application/json" \
  -d '{}'

# Should succeed - with valid Origin
curl -X POST http://api.localhost/api/sandboxes \
  -H "Cookie: better-auth.session_token=xxx" \
  -H "Origin: http://localhost:1420" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 4. Config Validation Test

```bash
# Test in production mode with dev secrets (should fail)
NODE_ENV=production bun run apps/api/src/index.ts

# Expected output:
# ❌ CONFIGURATION VALIDATION FAILED
# • API_TOKEN: Production API token cannot contain dev/test patterns...
```

---

## Checklist

- [ ] Create `apps/api/src/middleware/security-headers.ts`
- [ ] Create `apps/api/src/middleware/rate-limit.ts`
- [ ] Create `apps/api/src/middleware/csrf.ts`
- [ ] Create `apps/api/src/utils/validate-config.ts`
- [ ] Update `apps/api/src/auth/middleware.ts` (timing-safe comparison)
- [ ] Update `apps/api/src/config.ts` (remove prod defaults)
- [ ] Update `apps/api/src/index.ts` (add middlewares, error handler)
- [ ] Update `.env.example` (document required vars)
- [ ] Test rate limiting
- [ ] Test security headers
- [ ] Test CSRF protection
- [ ] Test config validation in production mode

---

## Next Phase

After completing Phase 1, proceed to [Phase 2: Observability](./phase-2-observability.md).
