import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { config, allowedOrigins, isAllowedOrigin } from './config.ts';
import { validateConfig } from './utils/validate-config.ts';
import { describeDatabase } from './utils/describe-database.ts';
import { initDatabase } from './db/drizzle.ts';
import { resetOrphanedOnlineNodes } from './services/node-registry.ts';
import { auth } from './auth/drizzle-auth.ts';
import { authMiddleware } from './auth/middleware.ts';
import { securityHeadersMiddleware } from './middleware/security-headers.ts';
import { rateLimitMiddleware } from './middleware/rate-limit.ts';
import { csrfMiddleware } from './middleware/csrf.ts';
import { createKaambaanPushRoutes } from './routes/kaambaan-push.ts';
import { servicePublicJwks } from './auth/service-signing.ts';
import { projectGate, tenantForBoard } from './services/matrix-as/gates.ts';
import { startGateSweeper } from './services/matrix-as/gate-sweep.ts';
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
// A node exchanging its credential for a station-scoped agent token
import { stationTokenRoutes } from './routes/station-token.ts';
// A node redeeming a human's authorization for a station's Matrix credential
import { stationMatrixCredentialRoutesFor } from './routes/station-matrix-credential.ts';
import { purposeRoutes } from './routes/purpose.ts';
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
import { stationChangesetRoutes } from './routes/station-changeset.ts';
import { nodePostureRoutes } from './routes/node-posture.ts';
import { runtimeCallbackRoutes } from './routes/runtime-callback.ts';
// ACP session routes (REST session management + console session WebSocket)
import { stationAcpRoutes } from './routes/station-acp.ts';
import { acpProxyRouter } from './routes/acp-proxy.ts';
// Middleware
import { activityLoggerMiddleware } from './middleware/activity-logger.ts';
import { registerEnabledProvisioners } from './services/provisioner/bootstrap.ts';
import { enabledProviders } from './services/provisioner/registry.ts';
import { startNodeSweeper } from './services/node-sweeper.ts';
import { startKaambaanBridge } from './services/bridge/loop.ts';
import { createMatrixBridge, startMatrixBridge } from './services/matrix-as/index.ts';
import { onStationsAdopted, onProvisionStation, onStationMatrixIdReported } from './services/matrix-as/hooks.ts';
import { preJoinNewIdentity, onNodeReportedMatrixId, moveState } from './services/matrix-as/identity-move.ts';
import { signalNodeToAdopt } from './services/matrix-as/adopt-signal.ts';
import { createMatrixAsRoutes } from './routes/matrix-as.ts';
import { createStationMatrixRoutes } from './routes/station-matrix.ts';
import { createStationSayRoutes } from './routes/station-say.ts';
import { createMissionRoutes } from './routes/missions.ts';
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
// The Matrix bridge, or null when this deployment has not opted in. Built
// BEFORE the routes so both mounts share one client and one config; null means
// neither is mounted, and a homeserver talking to us gets a 404 rather than a
// half-built bridge.
const matrixBridge = createMatrixBridge();

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
  /**
   * GET /api/auth/jwks — Better Auth's key set, plus this hub's service
   * signing keys.
   *
   * Registered BEFORE the catch-all below, because Hono matches in
   * registration order and the catch-all would otherwise swallow it.
   *
   * Merged here rather than published separately so consumers keep fetching
   * exactly one URL. kaambaan asks for `${issuer}/api/auth/jwks` and verifies
   * against whatever comes back; teaching it about a second endpoint would put
   * a deployment detail of this hub into another repository's code.
   *
   * If the plugin's own response cannot be parsed, this returns it untouched
   * rather than substituting a set of its own — a JWKS endpoint that starts
   * serving only half the keys would fail as "not authorized" at every
   * consumer, which is the least diagnosable outcome available.
   */
  .get('/api/auth/jwks', async (c) => {
    const upstream = await auth.handler(c.req.raw);
    try {
      const body = (await upstream.clone().json()) as { keys?: unknown[] };
      if (!Array.isArray(body.keys)) return upstream;
      return c.json({ ...body, keys: [...body.keys, ...(await servicePublicJwks())] });
    } catch {
      return upstream;
    }
  })
  // Better Auth routes - handle authentication (public, no auth middleware)
  .on(['GET', 'POST'], '/api/auth/*', (c) => {
    return auth.handler(c.req.raw);
  })
  /**
   * POST /api/nodes/:nodeId/stations/:stationId/token — a node exchanging its
   * long-term `<nodeId>:<nodeSecret>` credential for a short-lived agent
   * token. `Bearer <nodeId>:<nodeSecret>` is not a Better Auth session and is
   * never the static API_TOKEN either, so `authMiddleware` below would 401 it
   * before the route's own credential check ever ran — the same reason the
   * jwks route and `/api/auth/*` above are registered here, ahead of it. The
   * route authenticates itself; `/api` is still right for it (Bearer passes
   * CSRF, unlike the HMAC-signed `kaambaan-push` receiver under `/public`),
   * it just cannot sit behind a middleware built for a session.
   */
  .route('/api', stationTokenRoutes)
  /**
   * POST /api/nodes/:nodeId/stations/:stationId/matrix-credential — this
   * route's sibling redeeming a Matrix credential instead of a JWT. Same
   * self-authenticating Bearer, so it is registered here too, ahead of
   * `authMiddleware`. Mounted only when a Matrix bridge is configured —
   * with none, there is no homeserver to register or rotate an identity on,
   * so the route simply does not exist rather than 500ing on every call.
   * The mount decision itself lives in `stationMatrixCredentialRoutesFor`
   * (`station-matrix-credential.ts`) rather than inline here, so it has a
   * unit test that does not need to boot this whole file to run.
   */
  .route('/api', stationMatrixCredentialRoutesFor(matrixBridge))
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
  .route('/api', purposeRoutes)                            // PUT /api/stations/:id/purpose, /api/nodes/:id/purpose
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
  .route('/api', stationChangesetRoutes)                   // POST /api/stations/:id/changeset/{status,diff}
  .route('/api', nodePostureRoutes)                        // POST /api/nodes/:id/posture/scan
  .route('/public', runtimeCallbackRoutes)                 // POST /public/runtimes/:id/state
  .route('/api', stationAcpRoutes)                         // POST/GET /api/stations/:id/acp/sessions, WS /api/acp/sessions/:sessionId/ws
  .route('/api', acpProxyRouter);                          // WS /api/acp/proxy — Doors: an editor's stdio, piped by `apn acp`

// ── The Matrix Application Service ───────────────────────────────────────────
//
// Mounted OUTSIDE /api/* because the caller is a homeserver holding a shared
// secret, not a session — and only when the bridge is configured, so an
// unconfigured hub answers a homeserver with 404 rather than with a bridge that
// cannot act.
if (matrixBridge) {
  // Everything the ordered identity move needs, in one place: the appservice
  // client that can act as any `@agent_.*` user, and this homeserver's name.
  // Two call sites read it — the operator's authorise route (step 2) and the
  // convergence listener below (steps 5 and 6) — and they must be the same
  // deps or the two halves of one move could act on different homeservers.
  const identityMove = { domain: matrixBridge.config.domain, client: matrixBridge.client };

  // What the node reports on every detect, and the only thing that may set
  // the irreversible last step of a move going: `matrix_id = bridge_matrix_id`
  // is convergence (design §1), and until it holds, the station keeps working
  // under the identity it already has.
  onStationMatrixIdReported(async (stationId, mxid) => {
    await onNodeReportedMatrixId(stationId, mxid, identityMove);
  });

  // How a gate reaches a room, however it got here. Shared by the push
  // receiver and the sweep beneath it, so a swept gate and a pushed one cannot
  // be posted by two slightly different projections.
  const gateProjection = {
    domain: matrixBridge.config.domain,
    boardBaseUrl: process.env.KAAMBAAN_BOARD_URL,
    sendText: (userId: string, roomId: string, body: string) =>
      matrixBridge.client.sendText(userId, roomId, body),
    sendCustomEvent: (
      userId: string,
      roomId: string,
      eventType: string,
      content: Record<string, unknown>,
    ) => matrixBridge.client.sendCustomEvent(userId, roomId, eventType, content),
  };

  // POST /public/bridge/kaambaan/push — a board telling us a gate is open.
  //
  // Under /public, not /api, because the caller is a Worker holding a signing
  // secret rather than a browser holding a session — and /api/* carries the
  // CSRF middleware, which passes Bearer and would reject an HMAC-signed body.
  // `runtime-callback.ts` is already mounted here for the same reason.
  app.route(
    '/public',
    createKaambaanPushRoutes({
      secret: process.env.KAAMBAAN_PUSH_SECRET,
      tenantIdFor: tenantForBoard,
      ...gateProjection,
    }),
  );

  // …and the floor beneath it. kaambaan retries a push five times and then
  // dead-letters it, at which point the gate is silent on both sides: a card
  // blocked on an approval nobody was told about. This asks each board what it
  // is still waiting on. `projectGate` is idempotent on `gate_id`, so the two
  // paths are meant to overlap rather than to be arbitrated between.
  startGateSweeper({
    tenantIdFor: tenantForBoard,
    project: (tenantId, delivery) => projectGate(tenantId, delivery, gateProjection),
  });

  app.route(
    '/_matrix/app/v1',
    createMatrixAsRoutes({
      hsToken: matrixBridge.config.hsToken,
      domain: matrixBridge.config.domain,
      onEvent: (event) => matrixBridge.onEvent(event),
      onProvisionAlias: (alias) => matrixBridge.onProvisionAlias(alias),
    }),
  );

  // …and the operator-facing half, which IS session-authenticated.
  app.route(
    '/api',
    createStationMatrixRoutes({
      domain: matrixBridge.config.domain,
      provisionStation: (stationId) => matrixBridge.provision(stationId),
      credentials: {
        // An appservice registration returns an access_token directly — no
        // admin command, no password, no login round-trip.
        register: (localpart) => matrixBridge.client.registerWithCredentials(localpart),
        // And an appservice may LOG IN as any user in its own namespace, which
        // is how an identity that already exists gets new credentials without
        // the homeserver admin account this service exists to do away with.
        rotate: (localpart) => matrixBridge.client.rotateCredentials(localpart),
      },
      // Step 2 of the ordered move: the new identity goes into the room
      // before anything switches the credential. Wired here rather than
      // reached for inside the route, so the route stays testable and so a
      // hub with no bridge — which is where this route is not mounted at all
      // — cannot half-perform a move.
      preJoinNewIdentity: (stationId) => preJoinNewIdentity(stationId, identityMove),
      // Steps 3-5: the node is told to adopt, and whatever identity its
      // profile then reads as is announced through the SAME hook a detect
      // announces through — the one `onStationMatrixIdReported` above is
      // wired to. That is the whole of convergence's trigger; §4's "on its
      // next detect" describes a detect that never happens, because
      // matrix.adopt restarts the harness rather than the node-agent.
      signalNodeToAdopt: (args, signalDeps) => signalNodeToAdopt(args, signalDeps),
      // The four states of §1's invariant, for the console's panel. Same
      // function `moveInProgress` reads, so the operator's view and the gate
      // sweep's attribution can never disagree about what `waiting` means.
      moveState: (stationId) => moveState(stationId),
    }),
  );

  // An agent speaking without being spoken to — a cron job reporting in, and
  // the last thing keeping bridge mode short of parity with a harness's own
  // Matrix client.
  app.route(
    '/api',
    createStationSayRoutes({
      domain: matrixBridge.config.domain,
      client: matrixBridge.client,
    }),
  );

  // Rooms where several agents work together. A per-agent room is a DM; a
  // mission has several correspondents, so it is an ordinary room — and
  // ordinary rooms are what a space can group.
  app.route(
    '/api',
    createMissionRoutes({
      domain: matrixBridge.config.domain,
      client: matrixBridge.client,
    }),
  );
}

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

// Claim work from a kaambaan board, if this hub has been told to.
// Off unless ENABLE_KAAMBAAN_BRIDGE=true — a hub that has not opted in
// constructs nothing here, exactly like an unregistered provisioner driver.
const bridge = await startKaambaanBridge();
console.log(
  'kaambaan bridge:',
  bridge ? `claiming as ${bridge.agents.join(', ')}` : '(disabled)',
);

// Give every station a Matrix identity and a room, if the bridge is on. Runs
// after the routes are mounted so a homeserver that starts pushing immediately
// finds somewhere to push to.
if (matrixBridge) {
  // A station adopted at noon must not wait for a restart to get a room.
  onStationsAdopted(async (stationIds) => {
    for (const id of stationIds) await matrixBridge.provision(id);
  });
  // Nor must an agent assigned at noon. Adoption fires before a station has
  // an occupant, and a bridge-mode station with none is exactly what
  // `provision.ts` returns early from — so without this the console could
  // create an agent, put it in a station, and leave it with no room at all
  // until the next restart. `routes/agents-admin.ts` awaits this one.
  onProvisionStation((stationId) => matrixBridge.provision(stationId));
  await startMatrixBridge(matrixBridge);
} else {
  console.log('matrix bridge: (disabled)');
}

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
║  Database:    ${describeDatabase(config.database.url).padEnd(46)}║
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
