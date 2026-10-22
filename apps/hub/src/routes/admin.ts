/**
 * Admin API Routes
 * 
 * Endpoints for admin functionality:
 * - Principals (read through the org plane), agent placement, the bridge roster
 * - System statistics
 * - Audit log viewing
 * - Hub-wide settings (transcription, speech)
 *
 * Users, signup, grants, service principals and suspension are the org plane's (decision D3):
 * `retiredUnderPlane` answers those paths 410 `managed_by_org_plane`.
 */

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { hubOperatorMiddleware, isHubOperator, workspaceAdminMiddleware } from "../auth/workspace-authority";
import { authMiddleware } from "../auth/middleware";
import { resolveTenantId } from "../auth/tenant";

declare module "hono" {
  interface ContextVariableMap {
    /** Set by a route-specific admin guard that has already decided this request (admin.ts). */
    adminGateDecided: boolean;
    /** The caller holds the hub operator seat and reads every tenant's audit rows. */
    auditLogAllTenants: boolean;
  }
}
import { retiredUnderPlane } from "../auth/org-plane/retired";
import { adminPrincipalsRouter } from "./admin-principals";
import { agentsAdminRouter } from "./agents-admin";
import { adminBridgeAgentsRouter } from "./admin-bridge-agents";
import { adminBridgeBoardsRouter } from "./admin-bridge-boards";
import { adminTranscriptionRoutes } from "./transcription-settings";
import { adminSpeechRoutes } from "./speech-settings";

// Models
import { getAdminStats } from "../models/admin-users";
import { getAuditLogs } from "../models/admin-audit-log";

// =============================================================================
// Router Setup
// =============================================================================

export const adminRouter = new Hono();

// 410 managed_by_org_plane for what the plane now owns (decision D3).
// NOT ahead of authentication: index.ts mounts `/api/*` authMiddleware (and ban check, CSRF,
// activity log) before this router, so a caller is authenticated before they learn a route moved,
// and an unauthenticated one gets 401. Kept that way on purpose (security review finding 7b):
// answering 410 before auth would add an unauthenticated path that enumerates the admin surface,
// for no gain — the people who need the redirect are signed in. It runs ahead of this router's
// own authMiddleware and admin guards only so a non-operator learns the route moved instead of 403.
adminRouter.use("*", retiredUnderPlane());

// Apply auth middleware to all admin routes
adminRouter.use("*", authMiddleware);

// Two authorities (workspace authority spec, W1/W2; auth/workspace-authority.ts). The hub-wide
// settings are the hub operator seat's and nobody else's. Every other route here is what a
// workspace owns, and is its admins' — including a hub operator's only if their token says they
// are an admin of the workspace it names. The audit log is the one route both may read: a
// workspace admin reads their tenant's rows, the seat reads every row (a cross-tenant read named
// as one).
//
// The settings and audit-log guards are registered BEFORE the workspace-admin guard and mark the
// request as decided, so that guard does not refuse an operator who is a workspace member. Path
// matching is relative to this router's mount (Hono `use(path)`), never a regex over the URL.
const decided = (c: Context) => c.set("adminGateDecided", true);
adminRouter.use("/settings", hubOperatorMiddleware, async (c, next) => (decided(c), next()));
adminRouter.use("/settings/*", hubOperatorMiddleware, async (c, next) => (decided(c), next()));
adminRouter.use("/audit-log", async (c, next) => {
  if (await isHubOperator(c)) {
    c.set("auditLogAllTenants", true);
    decided(c);
  }
  return next();
});
adminRouter.use("*", async (c, next) => {
  if (c.get("adminGateDecided")) return next();
  return workspaceAdminMiddleware(c, next);
});

// Who exists in this workspace, read through the plane: a grant names a `prn_` id on
// both sides and nothing else in this API says what those ids are.
adminRouter.route("/principals", adminPrincipalsRouter);

// The superpipeline bridge's roster. Workspace administration: every write here decides what work
// this fleet claims and whose credential it spends. Replaces editing SUPERPIPELINE_BRIDGE_AGENTS
// in hub.env and restarting.
adminRouter.route("/bridge/agents", adminBridgeAgentsRouter);
// Per-board bridge settings: today the "Related prior work" switch. Same guard, same reason.
adminRouter.route("/bridge/boards", adminBridgeBoardsRouter);

// Creating an agent, and putting it in a station. Mounted at the root of
// `/api/admin` because it owns two path families — `/agents` and
// `/stations/:stationId/agent` — not one subtree.
adminRouter.route("/", agentsAdminRouter);

// =============================================================================
// Validation Schemas
// =============================================================================

const auditLogSchema = z.object({
  adminUserId: z.string().optional(),
  targetUserId: z.string().optional(),
  action: z.string().optional(),
  startDate: z.string().optional().transform(v => v ? new Date(v) : undefined),
  endDate: z.string().optional().transform(v => v ? new Date(v) : undefined),
  limit: z.string().optional().transform(v => v ? parseInt(v, 10) : 50),
  offset: z.string().optional().transform(v => v ? parseInt(v, 10) : 0),
});

// =============================================================================
// Statistics Routes
// =============================================================================

/**
 * GET /admin/stats
 * Get system-wide statistics
 */
adminRouter.get("/stats", async (c) => {
  // Counts for the caller's workspace (its `org`); the static API_TOKEN names none and counts all.
  const stats = await getAdminStats({ org: c.get("user")?.org });
  return c.json(stats);
});

// =============================================================================
// Audit Log Routes
// =============================================================================

/**
 * GET /admin/audit-log
 * Get admin audit log entries
 */
adminRouter.get("/audit-log", zValidator("query", auditLogSchema), async (c) => {
  const query = c.req.valid("query");

  const result = await getAuditLogs({
    // A workspace admin reads their tenant's rows only; the seat reads every row.
    ...(c.get("auditLogAllTenants") ? {} : { tenantId: resolveTenantId(c) }),
    adminUserId: query.adminUserId,
    targetUserId: query.targetUserId,
    action: query.action as any,
    startDate: query.startDate,
    endDate: query.endDate,
    limit: query.limit,
    offset: query.offset,
  });

  return c.json({
    entries: result.entries,
    total: result.total,
    limit: query.limit,
    offset: query.offset,
  });
});

// =============================================================================
// Settings Routes
// =============================================================================

/**
 * /admin/settings/transcription — the hub's default speech-to-text service
 * for voice notes (GET, PUT, POST /test). Inside this router so it sits
 * behind the same admin guard; see `routes/transcription-settings.ts`.
 */
adminRouter.route("/settings/transcription", adminTranscriptionRoutes());

/**
 * /admin/settings/speech — the hub's default text-to-speech service for
 * agents' spoken replies (GET, PUT, POST /test). Same guard; see
 * `routes/speech-settings.ts`.
 */
adminRouter.route("/settings/speech", adminSpeechRoutes());

/**
 * GET /admin/settings
 * Get all system settings
 */
adminRouter.get("/settings", async (c) => {
  const { getAllSettings } = await import("../models/system-settings");
  const settings = await getAllSettings();
  return c.json({ settings });
});
