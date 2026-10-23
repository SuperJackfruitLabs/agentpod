/**
 * One driver per strict Salaam run (run_d187f3907dd8470c, #776). Real runOnce, real ledger and real
 * lease renewals (`renewSalaamExecution`) against the owned test DB; synthetic daemon and board.
 *
 * The sequence from staging: the first delivery's reply is lost ("Salaam work delivery
 * unresolved"), and the run is then resumed by two loops at once. Both drivers renewed the one
 * execution lease, each renewal's compare-and-set on leaseSequence failed the other ("Salaam
 * authority changed while renewal was in flight"), the session ended and the run stranded.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
} from "../../src/db/schema/salaam-work";
import { runOnce, type DispatchDeps } from "../../src/services/bridge/dispatch";
import {
  makeSalaamExecution,
  renewSalaamExecution,
} from "../../src/services/salaam-authority";
import { workDigest } from "../../src/services/salaam-work";
import * as broker from "../../src/services/broker";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import planCorpus from "../../../../packages/contract/src/fixtures/salaam-work-payload-v1.json";
import type { RunContext } from "../../src/services/bridge/superpipeline";

beforeAll(async () => {
  await ensurePgMigrations();
});
afterAll(() => {});
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("delivery unresolved, a rebuild handover, then two loops resume the run: one drives it, the lease never collides", async () => {
  const tenant = "fleet_" + hex(),
    org = "org_" + hex(),
    user = "prn_" + hex(),
    principal = "prn_" + hex(),
    node = "node_" + hex(),
    station = "station_" + hex(),
    session = "acps_" + hex(),
    run = "run_" + hex(),
    board = "brd_" + hex(),
    card = "card_" + hex();
  const nativeSession = crypto.randomUUID(),
    admission = crypto.randomUUID(),
    task = crypto.randomUUID();
  fakePlane.addHuman({ id: user, grant: { mayDispatch: [principal] } });
  fakePlane.addAgent({ id: principal });
  for (const id of [user, principal])
    fakePlane.principals.get(id)!.organizationId = org;
  await db.insert(tenants).values({
    id: tenant,
    name: "one driver proof",
    externalSource: "org-plane",
    externalId: org,
  });
  await db.insert(nodes).values({
    id: node,
    tenantId: tenant,
    userId: user,
    name: "proof",
    hostname: "fixture",
    os: "test",
    arch: "test",
    secretHash: "not-real",
  });
  await db.insert(stations).values({
    id: station,
    tenantId: tenant,
    userId: user,
    nodeId: node,
    harness: "salaam",
    stationKey: "salaam:c52ddf65534b7b46",
    kind: "leaf",
    displayName: "proof",
    workspacePath: "/workspace",
    capabilities: ["acp"],
    principalId: principal,
  });
  let live: RunContext = {
    run: {
      runId: run,
      cardId: card,
      stageKey: "build",
      leaseEpoch: 1,
      status: "working",
      outcome: null,
      startedAt: "now",
      endedAt: null,
      handoff: null,
      completion: null,
    },
    card: {
      id: card,
      title: "one driver proof",
      spec: { salaam: { version: 1, plan: planCorpus.cases[0]!.payload.plan } },
    },
    stage: { key: "build", name: "Build" },
    handoff: null,
    references: [],
  };
  let admits = 0,
    renewsInFlight = 0,
    overlappingRenewals = 0,
    drives = 0,
    reports = 0,
    workRequest = "",
    bindingDigest = "";
  const mock = spyOn(broker, "request").mockImplementation(
    async (_target, verb, body: any) => {
      if (verb === "salaam.work-admit") {
        admits++;
        workRequest = body.admission.request_id;
        bindingDigest = workDigest(body.admission.binding);
        // The daemon admitted it, but the reply never reached the hub.
        if (admits === 1) return { ok: false, error: "timeout" };
        return {
          ok: true,
          data: {
            version: 1,
            state: "admitted",
            session_id: nativeSession,
            task_id: task,
            request_id: workRequest,
            binding_digest: bindingDigest,
            plan_revision: 1,
          },
        };
      }
      if (verb === "salaam.renew") {
        if (renewsInFlight > 0) overlappingRenewals++;
        renewsInFlight++;
        await pause(15);
        renewsInFlight--;
        return {
          ok: true,
          data: {
            admission_id: admission,
            session_id: nativeSession,
            binding: body.binding,
            binding_digest: "d".repeat(64),
            lease_sequence: body.lease_sequence,
            expires_at: Date.now() + 60_000,
            authorized: true,
            revoked: false,
            owned_execution_stopped: false,
            unresolved_operations: [],
            active_attempts: [],
            interrupted_attempts: [],
          },
        };
      }
      if (verb === "salaam.work-trace")
        return {
          ok: true,
          data: { version: 1, traceparent: body.traceparent, authority: false },
        };
      if (verb === "salaam.work-progress")
        return {
          ok: true,
          data: {
            version: 1,
            request_id: workRequest,
            work_request_id: workRequest,
            task_id: task,
            plan_revision: 1,
            binding_digest: bindingDigest,
          },
        };
      const completion = {
        version: 1,
        state: "verified",
        work_request_id: workRequest,
        task_id: task,
        plan_revision: 1,
        binding_digest: bindingDigest,
        completion_id: "artifact_completion_fixture",
        evidence_digest: "c".repeat(64),
      };
      if (verb === "salaam.work-status") {
        drives++;
        await pause(30);
        return {
          ok: true,
          data: { ...completion, state: "succeeded", auto_enabled: false },
        };
      }
      if (verb === "salaam.work-completion") return { ok: true, data: completion };
      throw Error("Unexpected private verb " + verb);
    },
  );
  let claims = 0;
  const deps = {
    tenantId: tenant,
    source: "superpipeline",
    agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
    client: {
      claim: async () =>
        ++claims === 1
          ? { runId: run, leaseEpoch: 1, card: live.card, stage: live.stage, handoff: null }
          : null,
      context: async () => live,
      heartbeat: async () => {},
      completeVerified: async (_lease: unknown, handoff: unknown) => {
        reports++;
        live = {
          ...live,
          run: {
            ...live.run,
            status: "ended",
            outcome: "completed",
            handoff,
            completion: { met: true, outcome: "pass" },
          },
        };
        return {};
      },
    },
    acp: {
      strictWork: async () => ({ required: true, version: 1 }),
      stationReady: async () => ({ ready: true }),
      createSession: async () => {
        const execution = await makeSalaamExecution(station, user, session, {
          source: "superpipeline",
          id: run,
          epoch: 1,
        });
        execution.sessionId = nativeSession;
        execution.admissionId = admission;
        await db.insert(acpSessions).values({
          id: session,
          tenantId: tenant,
          stationId: station,
          userId: user,
          mode: "ask",
          status: "idle",
          executionAuthority: execution,
          createdAt: new Date(),
          lastEventAt: new Date(),
        });
        return { id: session };
      },
      // The real renewal: the compare-and-set this race broke.
      renewExecution: async (userId: string, sessionId: string) => {
        await renewSalaamExecution(sessionId, userId);
      },
      endSession: async () => {},
      promptSession: async () => {
        throw Error("generic ACP prompt forbidden");
      },
    },
  } as unknown as DispatchDeps;
  try {
    expect(await runOnce(deps)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Salaam work delivery unresolved"),
    });
    // A loop being rebuilt yields the run at its first safe point and leaves the owner intact.
    expect(
      await runOnce({ ...deps, handover: AbortSignal.abort() } as DispatchDeps),
    ).toMatchObject({ status: "failed", reason: expect.stringContaining("handed over") });
    expect(drives).toBe(0);
    // Two loops on one agent resume the same run at once.
    const results = await Promise.all([runOnce(deps), runOnce(deps)]);
    expect(results.map((r) => r.status).sort()).toEqual(["idle", "reported"]);
    expect(results.find((r) => r.status === "idle")!.reason).toContain(
      "Another driver",
    );
    expect(overlappingRenewals).toBe(0);
    expect(drives).toBe(1);
    expect(reports).toBe(1);
    const [row] = await db
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.id, session));
    expect(row!.executionAuthority!.state).toBe("active");
    expect(row!.endedReason ?? null).toBeNull();
  } finally {
    mock.mockRestore();
    await db.delete(salaamWorkReports).where(eq(salaamWorkReports.tenantId, tenant));
    await db.delete(salaamWorkOwners).where(eq(salaamWorkOwners.tenantId, tenant));
    await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenant));
    await db.delete(bridgeDispatches).where(eq(bridgeDispatches.tenantId, tenant));
    await db.delete(stations).where(eq(stations.tenantId, tenant));
    await db.delete(nodes).where(eq(nodes.tenantId, tenant));
    await db.delete(tenants).where(eq(tenants.id, tenant));
    fakePlane.remove(user);
    fakePlane.remove(principal);
  }
});
