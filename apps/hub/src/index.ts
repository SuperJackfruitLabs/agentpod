import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config, allowedOrigins, isAllowedOrigin } from './config.ts';
import { validateConfig } from './utils/validate-config.ts';
import { initDatabase } from './db/drizzle.ts';
import { resetOrphanedOnlineNodes } from './services/node-registry.ts';
import { auth } from './auth/drizzle-auth.ts';
import { authMiddleware } from './auth/middleware.ts';
import { securityHeadersMiddleware } from './middleware/security-headers.ts';
import { rateLimitMiddleware } from './middleware/rate-limit.ts';
import { csrfMiddleware } from './middleware/csrf.ts';
import { createLogger } from './utils/logger.ts';
import { healthRoutes } from './routes/health.ts';
// Node gateway WebSocket routes
import { gatewayRoutes } from './routes/gateway.ts';
// Shared Bun WebSocket handler (terminal + gateway share one instance)
import { websocket } from './ws.ts';
// Admin routes
import { adminRouter } from './routes/admin.ts';
import { banCheckMiddleware, signupCheckMiddleware } from './auth/admin-middleware.ts';
// Cloudflare webhook integration
import { cloudflareWebhookRoutes } from './routes/cloudflare-webhook.ts';
// Node fleet enrollment & registry
import { nodeEnrollRoutes, nodeRoutes } from './routes/nodes.ts';
// Fleet aggregate read (Overview home — control-plane P1)
import { fleetRoutes } from './routes/fleet.ts';
import { enrollmentTokenRoutes } from './routes/enrollment-tokens.ts';
// Runtime provisioning routes
import { runtimeRoutes } from './routes/runtimes.ts';
// Station routes (detect, adopt, list, unadopt)
import { stationRoutes } from './routes/stations.ts';
// Station terminal WebSocket bridge (fleet console ↔ node PTY)
import { stationTerminalRoutes } from './routes/station-terminal.ts';
// Station activity endpoint (audit log, fleet console)
import { stationActivityRoutes } from './routes/station-activity.ts';
// Fleet-wide activity log (all stations for the authenticated user)
import { fleetActivityRoutes } from './routes/activity-fleet.ts';
// Station write routes (fs.write/mkdir/move/delete — capability-gated, audited)
import { stationWriteRoutes } from './routes/station-writes.ts';
import { stationLifecycleRoutes } from './routes/station-lifecycle.ts';
import { stationCleanupRoutes } from './routes/station-cleanup.ts';
// ACP session routes (REST session management + console session WebSocket)
import { stationAcpRoutes } from './routes/station-acp.ts';
import { acpProxyRouter } from './routes/acp-proxy.ts';
// Middleware
import { activityLoggerMiddleware } from './middleware/activity-logger.ts';
import { registerEnabledProvisioners } from './services/provisioner/bootstrap.ts';
import { enabledProviders } from './services/provisioner/registry.ts';
import { startNodeSweeper } from './services/node-sweeper.ts';
// ACP session boot reconciliation (hub-owned sessions do not survive restarts)
import { reconcileOnBoot as reconcileAcpSessions } from './services/acp-sessions.ts';

validateConfig();

console.log('Initializing database...');
await initDatabase();

const orphans = await resetOrphanedOnlineNodes();
if (orphans > 0) console.log(`Reset ${orphans} orphaned online node(s) to offline`);

// Mark ACP sessions from before the restart ended + best-effort close orphaned
// agent processes on nodes that are already back online.
await reconcileAcpSessions();

const errorLogger = createLogger('error-handler');

// Create the Hono app
const app = new Hono()
  // Middleware
  .use('*', logger())
  // CORS configuration - allow credentials for Better Auth cookies
  .use('*', cors({
    // Origin list lives in config.ts (corsAllowedOrigins) so station-terminal.ts
    // can re-use it for CSWSH defence without duplicating it here.
    origin: (origin) => {
      if (!origin) return allowedOrigins[0]!;
      if (isAllowedOrigin(origin)) return origin;
      return allowedOrigins[0]!;
    },
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
    maxAge: 600,
  }))
  .use('*', securityHeadersMiddleware)
  .use('*', rateLimitMiddleware)
  .route('/', healthRoutes)
  // Public node enrollment (no session — node authenticates with a one-time token in the body)
  .route('/public/nodes', nodeEnrollRoutes)  // POST /public/nodes/enroll
  // Public node gateway (no session — node authenticates with long-term credentials)
  .route('/public/nodes', gatewayRoutes)     // GET /public/nodes/gateway (WSS)
  // Signup check middleware - block signup if disabled (runs before auth handler)
  .use('/api/auth/*', signupCheckMiddleware)
  // Better Auth routes - handle authentication (public, no auth middleware)
  .on(['GET', 'POST'], '/api/auth/*', (c) => {
    return auth.handler(c.req.raw);
  })
  .use('/api/*', authMiddleware)
  .use('/api/*', banCheckMiddleware) // Block banned users
  .use('/api/*', csrfMiddleware)
  .use('/api/*', activityLoggerMiddleware)
  // Admin endpoints (require admin role)
  .route('/api/admin', adminRouter)
  // Cloudflare webhook integration
  .route('/api/v2/cloudflare', cloudflareWebhookRoutes)
  // Node fleet management (authenticated)
  .route('/api/enrollment-tokens', enrollmentTokenRoutes)  // POST /api/enrollment-tokens
  .route('/api/nodes', nodeRoutes)                         // GET /api/nodes
  // Fleet aggregate read (Overview home — control-plane P1)
  .route('/api/fleet', fleetRoutes)                        // GET /api/fleet/agents, /api/fleet/stats
  .route('/api/runtimes', runtimeRoutes)                   // CRUD /api/runtimes
  // Station routes (detect, adopt, list, unadopt)
  .route('/api', stationRoutes)                            // GET/POST/DELETE /api/nodes/:id/... and /api/stations/:id
  // Station terminal WebSocket bridge (fleet console ↔ node PTY)
  .route('/api', stationTerminalRoutes)                    // WS /api/stations/:id/terminal
  // Station activity log (audit rows, fleet console)
  .route('/api', stationActivityRoutes)                    // GET /api/stations/:id/activity
  // Fleet-wide activity log (all stations for the authenticated user)
  .route('/api', fleetActivityRoutes)                      // GET /api/activity
  // Station write routes (fs.write/mkdir/move/delete — capability-gated, audited)
  .route('/api', stationWriteRoutes)                       // POST /api/stations/:id/fs/{write,mkdir,move,delete}
  .route('/api', stationLifecycleRoutes)                   // POST /api/stations/:id/lifecycle
  .route('/api', stationCleanupRoutes)                     // POST /api/stations/:id/cleanup/{plan,apply}
  .route('/api', stationAcpRoutes)                         // POST/GET /api/stations/:id/acp/sessions, WS /api/acp/sessions/:sessionId/ws
  .route('/api', acpProxyRouter);                          // WS /api/acp/proxy — Doors: an editor's stdio, piped by `apn acp`

app.onError((err, c) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  const isProduction = config.nodeEnv === 'production';

  errorLogger.error('Unhandled error', {
    requestId,
    error: err.message,
    stack: err.stack,
    path: c.req.path,
    method: c.req.method,
    userId: c.get('user')?.id,
  });

  let status = 500;
  if ('status' in err && typeof err.status === 'number') {
    status = err.status;
  }

  return c.json(
    {
      error: isProduction ? 'Internal Server Error' : err.name,
      message: isProduction ? 'An unexpected error occurred' : err.message,
      requestId,
      ...(isProduction ? {} : { stack: err.stack }),
    },
    status as Parameters<typeof c.json>[1]
  );
});

app.notFound((c) => {
  return c.json(
    {
      error: 'Not Found',
      message: `Route ${c.req.method} ${c.req.path} not found`,
    },
    404
  );
});

export type AppType = typeof app;

// Export app for testing
export { app };

// Register runtime provisioner drivers (Docker/Cloudflare) for enabled providers.
// Without this, provisioning returns 400 ("provider not registered").
registerEnabledProvisioners();
console.log('Provisioners registered:', enabledProviders().join(', ') || '(none enabled)');

// Expire silent nodes whose TCP close never fired (killed VM, dropped network).
startNodeSweeper();
console.log('Node heartbeat sweeper started (45s threshold)');

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  process.exit(0);
});

// Start server
const port = config.port;

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              AgentPod Fleet Console — Hub API                 ║
╠═══════════════════════════════════════════════════════════════╣
║  Port:        ${String(port).padEnd(46)}║
║  Environment: ${config.nodeEnv.padEnd(46)}║
║  Database:    ${config.database.path.padEnd(46)}║
╠═══════════════════════════════════════════════════════════════╣
║  Auth Endpoints (Better Auth):                                ║
║  - POST /api/auth/sign-in/email       Email/password sign-in  ║
║  - POST /api/auth/sign-up/email       Email/password sign-up  ║
║  - POST /api/auth/sign-in/social      GitHub OAuth sign-in    ║
║  - GET  /api/auth/callback/github     OAuth callback          ║
║  - GET  /api/auth/session             Get current session     ║
║  - POST /api/auth/sign-out            Sign out                ║
╠═══════════════════════════════════════════════════════════════╣
║  Admin Endpoints (require admin role):                        ║
║  - GET  /api/admin/users                List all users        ║
║  - GET  /api/admin/users/:id            Get user details      ║
║  - POST /api/admin/users/:id/ban        Ban user              ║
║  - POST /api/admin/users/:id/unban      Unban user            ║
║  - PUT  /api/admin/users/:id/role       Update user role      ║
║  - GET  /api/admin/audit-log            Admin audit log       ║
╠═══════════════════════════════════════════════════════════════╣
║  Node Fleet Endpoints:                                        ║
║  - POST /public/nodes/enroll          Enroll node             ║
║  - GET  /public/nodes/gateway         Node gateway (WSS)      ║
║  - GET  /api/nodes                    List nodes              ║
║  - GET  /api/enrollment-tokens        List tokens             ║
║  - POST /api/enrollment-tokens        Create token            ║
╠═══════════════════════════════════════════════════════════════╣
║  Runtime Endpoints:                                           ║
║  - GET  /api/runtimes                 List runtimes           ║
║  - POST /api/runtimes                 Provision runtime       ║
║  - DELETE /api/runtimes/:id           Destroy runtime         ║
╠═══════════════════════════════════════════════════════════════╣
║  Station Endpoints:                                           ║
║  - GET  /api/stations                 List stations           ║
║  - GET  /api/stations/:id             Get station             ║
║  - WS   /api/stations/:id/terminal    Station terminal        ║
║  - GET  /api/stations/:id/activity    Station audit log       ║
║  - GET  /api/activity                 Fleet-wide activity     ║
║  - POST /api/stations/:id/fs/write    Write file              ║
║  - POST /api/stations/:id/lifecycle   Lifecycle control       ║
║  - POST /api/stations/:id/cleanup     Cleanup (plan/apply)    ║
╚═══════════════════════════════════════════════════════════════╝
`);

export default {
  port,
  fetch: app.fetch,
  websocket,
};
