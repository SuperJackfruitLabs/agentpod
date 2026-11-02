/**
 * Activity Logger Middleware (stub)
 *
 * The OpenCode-era activity log (activity_logs table) has been removed in P2b.
 * Fleet-console audit trail uses station_audit_log instead (services/audit/audit.ts).
 * This file is kept as a no-op stub so the import in index.ts still resolves.
 */

import { createMiddleware } from "hono/factory";

/**
 * No-op middleware — passes through every request unchanged.
 * The fleet console's audit trail is handled by services/audit/audit.ts at the
 * route level (station-activity, station-writes, etc.).
 */
export const activityLoggerMiddleware = createMiddleware(async (_c, next) => {
  await next();
});
