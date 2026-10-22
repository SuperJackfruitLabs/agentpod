import { cors } from 'hono/cors';
import { isAllowedOrigin } from '../config.ts';

/**
 * Response headers the console (a different origin) must be able to read.
 * A header not listed here is invisible to browser JS on a cross-origin fetch.
 * `X-Truncated` is set by GET /api/stations/:id/file when it cuts a read short.
 */
export const exposedHeaders = [
  'Content-Length',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
  'X-RateLimit-Reset',
  'X-Truncated',
];

// Origin list lives in config.ts (allowedOrigins) so station-terminal.ts can re-use it
// for CSWSH defence without duplicating it here.
export const corsMiddleware = cors({
  // Echo an allowed origin; otherwise send no Access-Control-Allow-Origin at all. This used to
  // fall back to allowedOrigins[0], which is the Vite dev server: every request without an
  // Origin (curl, a server, the conformance script) or from an unknown one was told
  // "http://localhost:5173", which read on staging as a misconfigured allowlist (spec
  // 2026-10-23, open question 5). A browser on a disallowed origin is refused either way.
  origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: exposedHeaders,
  maxAge: 600,
});
