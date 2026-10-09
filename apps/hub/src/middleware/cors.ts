import { cors } from 'hono/cors';
import { allowedOrigins, isAllowedOrigin } from '../config.ts';

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
  origin: (origin) => {
    if (!origin) return allowedOrigins[0]!;
    if (isAllowedOrigin(origin)) return origin;
    return allowedOrigins[0]!;
  },
  credentials: true,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: exposedHeaders,
  maxAge: 600,
});
