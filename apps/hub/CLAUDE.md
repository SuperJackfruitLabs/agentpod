# Hub

Fleet-console backend: Bun + Hono (chained routes, `AppType` export) + Drizzle/Postgres. Entry: `src/index.ts` — boot order matters: config validation → `initDatabase()` (migrations auto-apply on boot) → `resetOrphanedOnlineNodes()` → route mounting → provisioner registration → node sweeper.

## Commands

```bash
DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
bun run dev          # :3001
bun run typecheck    # KNOWN RED: pre-existing tsc errors in stations.ts files; they do not fail bun test — don't "fix" in passing
```

Test DB requirements (pgvector image + env override): see root `CLAUDE.md` / `TESTING.md`.

## Architecture facts that bite

- **Node gateway** (`routes/gateway.ts`, WSS `/public/nodes/gateway`, auth `Bearer <nodeId>:<nodeSecret>`): onMessage must await `authReady` (one-shot frames race async auth); teardown is epoch-guarded (`connectionManager.isCurrent`) so a late close from a replaced socket can't kill a fresh connection; a heartbeat on an unregistered socket re-registers it.
- **Sweeper** (`services/node-sweeper.ts`): every 15s, expires online nodes silent >45s (agent heartbeats every 15s) with the same full teardown as a real close. False positives self-heal via heartbeat re-register. The same tick runs `sweepStalledRuntimeStarts` (`services/runtimes.ts`): a runtime left `starting`/`provisioning` for >2min with an externalId becomes `error` + `statusReason`. It also runs `sweepStalledRuntimeStops`, which asks each `stopping` runtime's driver whether its container is down — confirming → `stopped`, still up or still unanswered after 5min → `error` + `statusReason`.
- **Runtime `online` is evidence-only**: only `enrollment.ts` writes it, because a node enrolled. `startRuntime` writes `starting` — the substrate accepting a start request is not a node existing (issue #254). Never widen a lifecycle write back to `online` on a driver call returning.
- **Runtime `stopped` is evidence-only too**: written only on `RuntimeProvisioner.status()` reporting the container down, never because `stop()` resolved. `stopRuntime` writes `stopping`. **The absence of a node is not evidence of a stop** — nodes go offline for network reasons while their container runs, and bills. A driver with no `status()` gets `stopped` with an "unverified" `statusReason`; a driver that answers `unknown` past the timeout gets `error`. The Cloudflare answer needs `cloudflare/worker-v2` deployed with the state-reporting `GET /sandbox/:id`; an older deployment reads as `unknown`.
- **Broker** (`services/broker.ts`): request/stream correlation by UUID; `request()` never rejects — resolves `{ok:false, error}` on timeout/offline/disconnect.
- **Auth**: Better Auth, session cookies; secret comes from config (`BETTER_AUTH_SECRET`) passed explicitly to `betterAuth({secret})`. First signup becomes admin, then signup closes (`system_settings`).
- **Stations**: presence in the `stations` table = adopted; there is no `adopted` column. Observe routes (`/api/stations/:id/...`) proxy to the node via broker and 502 on node-side failure.
- **Errors skip CORS**: an exception thrown before Hono's CORS middleware finishes means the browser reports a CORS error — read the hub log for the real failure before chasing CORS.

## Tests

Unit next to code or `tests/unit/`; DB-touching in `tests/integration/` (per-file row cleanup in `afterAll`). WS/gateway tests build a minimal Hono app — never import `src/index.ts` (it starts the sweeper and boot hooks).
