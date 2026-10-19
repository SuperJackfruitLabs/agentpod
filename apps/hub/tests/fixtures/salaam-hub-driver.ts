/** Disposable real Hub service/gateway driver. No production boot hooks or fleet credentials. */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "../../src/db/drizzle";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { tenants, BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { fakePlane, installFakePlane, TEST_ORG } from "../helpers/fake-plane";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { connectionManager } from "../../src/services/connection-manager";
import { gatewayRoutes } from "../../src/routes/gateway";
import { websocket } from "../../src/ws";
import * as sessions from "../../src/services/acp-sessions";
import * as authority from "../../src/services/salaam-authority";

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const database = new URL(process.env.DATABASE_URL ?? "http://missing");
if (
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  database.port !== "5434" ||
  database.pathname !== "/agentpod"
)
  throw Error("Use only the isolated pgvector database on loopback:5434");
installFakePlane();
fakePlane.addHuman({
  id: cfg.userId,
  grant: { mayDispatch: [cfg.principalId, cfg.otherPrincipalId] },
});
fakePlane.addAgent({ id: cfg.principalId });
fakePlane.addAgent({ id: cfg.otherPrincipalId });
await ensurePgMigrations();
await db
  .update(tenants)
  .set({ externalId: TEST_ORG, externalSource: "org-plane" })
  .where(eq(tenants.id, BOOTSTRAP_TENANT_ID));
await createTestUser({ id: cfg.userId });
await fakePlane.putGrant(cfg.userId, {
  mayDispatch: [cfg.principalId, cfg.otherPrincipalId],
  mayGrantReach: false,
  scopes: [],
});
await db
  .insert(nodes)
  .values({
    id: cfg.nodeId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: cfg.userId,
    name: "Salaam execution proof",
    hostname: "disposable",
    os: process.platform,
    arch: process.arch,
    secretHash: await Bun.password.hash(cfg.nodeSecret),
  })
  .onConflictDoNothing();
await db
  .insert(stations)
  .values({
    id: cfg.stationId,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: cfg.userId,
    nodeId: cfg.nodeId,
    harness: "salaam",
    stationKey: cfg.stationKey,
    kind: "leaf",
    displayName: "Salaam proof",
    workspacePath: cfg.workspace,
    capabilities: ["inventory", "health", "acp"],
    principalId: cfg.principalId,
  })
  .onConflictDoNothing();
await sessions.reconcileOnBoot();
const app = new Hono().route("/public/nodes", gatewayRoutes);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: cfg.port ?? 0,
  fetch: app.fetch,
  websocket,
});
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
send({ kind: "ready", port: server.port });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  void (async () => {
    const request = JSON.parse(line),
      p = request.params ?? {};
    try {
      let result: unknown;
      switch (request.method) {
        case "online":
          result = connectionManager.isOnline(cfg.nodeId);
          break;
        case "create":
          result = await sessions.createSession({
            stationId: cfg.stationId,
            userId: cfg.userId,
            mode: "ask",
          });
          break;
        case "prompt":
          result = await sessions.promptSession(cfg.userId, p.id, p.text);
          break;
        case "record":
          result = (
            await db.select().from(acpSessions).where(eq(acpSessions.id, p.id))
          )[0];
          break;
        case "status": {
          const [row] = await db
            .select()
            .from(acpSessions)
            .where(eq(acpSessions.id, p.id));
          result = row?.executionAuthority
            ? await authority.inspectSalaamExecution(row.executionAuthority)
            : null;
          break;
        }
        case "renew":
          await sessions.renewExecution(cfg.userId, p.id, p.run);
          result = true;
          break;
        case "end":
          await sessions.endSession(
            cfg.userId,
            p.id,
            "Fixture work authority revoked",
          );
          result = true;
          break;
        case "readiness":
          result = await sessions.stationReadiness(cfg.userId, cfg.stationId);
          break;
        case "reassign":
          await db
            .update(stations)
            .set({ principalId: p.principalId })
            .where(eq(stations.id, cfg.stationId));
          result = true;
          break;
        case "suspend":
          await fakePlane.suspend(p.id);
          result = true;
          break;
        case "unsuspend":
          await fakePlane.unsuspend(p.id);
          result = true;
          break;
        case "station":
          result = (
            await db
              .select()
              .from(stations)
              .where(eq(stations.id, cfg.stationId))
          )[0];
          break;
        case "board-create": {
          await db
            .insert(bridgeDispatches)
            .values({
              externalSource: "superpipeline",
              externalRunId: p.runId,
              tenantId: BOOTSTRAP_TENANT_ID,
              boardId: "board-fixture",
              externalCardId: p.runId,
              agentKey: cfg.userId,
              stationId: cfg.stationId,
              leaseEpoch: p.epoch,
              outcome: "working",
              startedAt: new Date(),
              updatedAt: new Date(),
            });
          result = await sessions.createSession({
            stationId: cfg.stationId,
            userId: cfg.userId,
            mode: "ask",
            executionRun: {
              source: "superpipeline",
              id: p.runId,
              epoch: p.epoch,
            },
            validateExecutionRun: async () => true,
          });
          break;
        }
        case "stale-run":
          await db
            .update(bridgeDispatches)
            .set({ leaseEpoch: p.epoch })
            .where(eq(bridgeDispatches.externalRunId, p.runId));
          result = true;
          break;
        case "cleanup":
          for (const row of await db
            .select()
            .from(acpSessions)
            .where(eq(acpSessions.userId, cfg.userId)))
            await sessions
              .endSession(cfg.userId, row.id, "Fixture cleanup")
              .catch(() => {});
          await db
            .delete(bridgeDispatches)
            .where(eq(bridgeDispatches.agentKey, cfg.userId));
          await db
            .delete(acpSessions)
            .where(eq(acpSessions.userId, cfg.userId));
          await deleteTestUser(cfg.userId);
          result = true;
          break;
        default:
          throw Error("Unknown fixture method");
      }
      send({ kind: "result", id: request.id, result: result ?? null });
    } catch (error) {
      send({ kind: "result", id: request.id, error: (error as Error).message });
    }
  })().catch(() => (process.exitCode = 1));
});
process.once(
  "SIGTERM",
  () =>
    void (async () => {
      server.stop(true);
      await closeDatabase();
      process.exit(0);
    })(),
);
