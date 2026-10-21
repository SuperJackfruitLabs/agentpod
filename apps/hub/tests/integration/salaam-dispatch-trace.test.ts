/** Real runOnce/start/recovery and local OTel export; synthetic daemon/board, owned test DB. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
} from "../../src/db/schema/salaam-work";
import { runOnce, type DispatchDeps } from "../../src/services/bridge/dispatch";
import { makeSalaamExecution } from "../../src/services/salaam-authority";
import { workDigest } from "../../src/services/salaam-work";
import * as broker from "../../src/services/broker";
import {
  _setProvidersForTest,
  ensureContextManager,
  instruments,
  resetTelemetry,
} from "../../src/telemetry/otel";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import planCorpus from "../../../../packages/contract/src/fixtures/salaam-work-payload-v1.json";
import type { RunContext } from "../../src/services/bridge/superpipeline";

let collectorDown = false,
  failedDeliveries = 0;
const delivered: ReadableSpan[] = [],
  attempted: ReadableSpan[] = [];
const exporter: SpanExporter = {
  export(spans, callback) {
    attempted.push(...spans);
    if (collectorDown) {
      failedDeliveries++;
      callback({ code: 1, error: Error("local collector unavailable") });
    } else {
      delivered.push(...spans);
      callback({ code: 0 });
    }
  },
  async shutdown() {},
};
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(async () => {
  await ensurePgMigrations();
  ensureContextManager();
  _setProvidersForTest({ tracerProvider: provider });
});
afterAll(async () => {
  resetTelemetry();
  await provider.shutdown();
});
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);

for (const outage of [false, true])
  test(`strict runOnce start and original-owner recovery carry source context; collector outage=${outage}`, async () => {
    collectorDown = false;
    failedDeliveries = 0;
    delivered.length = 0;
    attempted.length = 0;
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
      task = crypto.randomUUID();
    fakePlane.addHuman({ id: user, grant: { mayDispatch: [principal] } });
    fakePlane.addAgent({ id: principal });
    for (const id of [user, principal])
      fakePlane.principals.get(id)!.organizationId = org;
    await db.insert(tenants).values({
      id: tenant,
      name: "strict trace proof",
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
        title: "trace proof",
        spec: {
          salaam: { version: 1, plan: planCorpus.cases[0]!.payload.plan },
        },
      },
      stage: { key: "build", name: "Build" },
      handoff: null,
      references: [],
    };
    let claims = 0,
      sessions = 0,
      progresses = 0,
      reports = 0,
      ended = 0,
      workRequest = "",
      bindingDigest = "",
      savedSourceParent: string | undefined;
    const forwarded: string[] = [],
      nativeInvocationParents: string[] = [],
      progressRequests: unknown[] = [];
    const mock = spyOn(broker, "request").mockImplementation(
      async (target, verb, body: any) => {
        expect(target).toBe(node);
        if (verb === "salaam.work-admit") {
          workRequest = body.admission.request_id;
          bindingDigest = workDigest(body.admission.binding);
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
        if (verb === "salaam.work-trace") {
          const active = trace.getSpan(context.active())!.spanContext();
          expect(body.traceparent).toContain(active.traceId);
          expect(active.traceId).not.toBe("0".repeat(32));
          expect(body.binding.run).toEqual({
            source: "superpipeline",
            id: run,
            epoch: 1,
          });
          forwarded.push(body.traceparent);
          if (outage && progresses > 0)
            return { ok: false, error: "trace control unavailable" };
          savedSourceParent ??= body.traceparent;
          return {
            ok: true,
            data: {
              version: 1,
              traceparent: savedSourceParent,
              authority: false,
            },
          };
        }
        if (verb === "salaam.work-progress") {
          progresses++;
          progressRequests.push(body);
          nativeInvocationParents.push(savedSourceParent!);
          if (progresses === 1) throw Error("lost progression response");
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
        }
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
        if (verb === "salaam.work-status")
          return {
            ok: true,
            data: { ...completion, state: "succeeded", auto_enabled: false },
          };
        if (verb === "salaam.work-completion")
          return { ok: true, data: completion };
        throw Error("Unexpected private verb " + verb);
      },
    );
    const deps = {
      tenantId: tenant,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        claim: async () => {
          claims++;
          if (claims !== 1) throw Error("duplicate claim");
          return {
            runId: run,
            leaseEpoch: 1,
            card: live.card,
            stage: live.stage,
            handoff: null,
          };
        },
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
          sessions++;
          const execution = await makeSalaamExecution(station, user, session, {
            source: "superpipeline",
            id: run,
            epoch: 1,
          });
          execution.sessionId = nativeSession;
          execution.admissionId = crypto.randomUUID();
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
        renewExecution: async () => {},
        endSession: async () => {
          ended++;
        },
        promptSession: async () => {
          throw Error("generic ACP prompt forbidden");
        },
      },
    } as unknown as DispatchDeps;
    const claimMetric = spyOn(instruments().dispatches, "add");
    try {
      expect(await runOnce(deps)).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("lost progression response"),
      });
      expect(forwarded).toHaveLength(1);
      const original = savedSourceParent!;
      expect(original).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/);
      const initialRoot = delivered.find(
        (s) => s.name === "dispatch" && s.attributes["run.id"] === run,
      )!;
      expect(initialRoot.spanContext().traceId).toBe(original.split("-")[1]!);
      expect(initialRoot.attributes).toMatchObject({
        "dispatch.observation": "strict-start",
        "run.epoch": 1,
        "hub.session.id": session,
        "salaam.session.id": nativeSession,
        "task.id": task,
      });
      collectorDown = outage;
      expect(await runOnce(deps)).toMatchObject({
        status: "reported",
        externalRunId: run,
      });
      expect(forwarded).toHaveLength(2);
      const recovered = attempted.find(
        (s) =>
          s.name === "dispatch" &&
          s.attributes["run.id"] === run &&
          s.attributes["dispatch.observation"] === "strict-resume",
      )!;
      expect(recovered.attributes).toMatchObject({
        "run.epoch": 1,
        "hub.session.id": session,
        "salaam.session.id": nativeSession,
        "task.id": task,
      });
      expect(recovered.spanContext().traceId).toBe(
        forwarded[1]!.split("-")[1]!,
      );
      expect(savedSourceParent).toBe(original);
      expect(nativeInvocationParents).toEqual([original, original]);
      // The no-op API shares one counter across instruments, including the SDK
      // span metrics. Only dispatch outcomes count claims; recovery adds none.
      expect(
        claimMetric.mock.calls.filter(([, attributes]) =>
          attributes?.["dispatch.status"] !== undefined,
        ),
      ).toEqual([[1, { "dispatch.status": "failed" }]]);
      expect(claims).toBe(1);
      expect(sessions).toBe(1);
      expect(reports).toBe(1);
      expect(ended).toBe(1);
      expect(progressRequests[0]).toEqual(progressRequests[1]);
      const owners = await db
        .select()
        .from(salaamWorkOwners)
        .where(eq(salaamWorkOwners.tenantId, tenant));
      expect(owners).toHaveLength(1);
      expect(owners[0]!.requestId).toBe(workRequest);
      expect(owners[0]!.telemetryStatus).toBe(
        outage ? "unavailable" : "recorded",
      );
      expect(
        await db.select().from(acpRuns).where(eq(acpRuns.tenantId, tenant)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.tenantId, tenant)),
      ).toHaveLength(1);
      if (outage) expect(failedDeliveries).toBeGreaterThan(0);
    } finally {
      collectorDown = false;
      mock.mockRestore();
      claimMetric.mockRestore();
      await db
        .delete(salaamWorkReports)
        .where(eq(salaamWorkReports.tenantId, tenant));
      await db
        .delete(salaamWorkOwners)
        .where(eq(salaamWorkOwners.tenantId, tenant));
      await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenant));
      await db
        .delete(bridgeDispatches)
        .where(eq(bridgeDispatches.tenantId, tenant));
      await db.delete(stations).where(eq(stations.tenantId, tenant));
      await db.delete(nodes).where(eq(nodes.tenantId, tenant));
      await db.delete(tenants).where(eq(tenants.id, tenant));
      fakePlane.remove(user);
      fakePlane.remove(principal);
    }
  });
