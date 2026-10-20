/** Synthetic plane + real owned Postgres; no model or deployed station. */
import { beforeAll, afterAll, expect, test, spyOn } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpSessions } from "../../src/db/schema/acp";
import { bridgeDispatches } from "../../src/db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkDecisions,
  salaamWorkReports,
} from "../../src/db/schema/salaam-work";
import { makeSalaamExecution } from "../../src/services/salaam-authority";
import {
  reserveSalaamWork,
  deliverSalaamWork,
} from "../../src/services/bridge/salaam-work";
import {
  openDispatch,
  recordProduced,
  markReported,
  findUnreportedOutput,
} from "../../src/services/bridge/ledger";
import { workDigest } from "../../src/services/salaam-work";
import * as broker from "../../src/services/broker";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import corpus from "../../../../packages/contract/src/fixtures/salaam-work-payload-v1.json";
import type {
  ClaimedWork,
  RunContext,
} from "../../src/services/bridge/superpipeline";
const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenantId = "fleet_" + hex(),
  org = "org_" + hex(),
  user = "prn_" + hex(),
  principal = "prn_" + hex(),
  node = "node_" + hex(),
  station = "station_" + hex(),
  session = "acps_" + hex(),
  run = "run_" + hex(),
  card = "card_" + hex(),
  board = "brd_" + hex();
const key = {
  tenantId,
  externalSource: "superpipeline",
  externalRunId: run,
  externalCardId: card,
  boardId: board,
};
const claim: ClaimedWork = {
  runId: run,
  leaseEpoch: 1,
  card: { id: card, title: "Proof" },
  stage: { key: "build", name: "Build" },
  handoff: null,
};
const context: RunContext = {
  run: {
    runId: run,
    cardId: card,
    stageKey: "build",
    leaseEpoch: 1,
    status: "working",
    outcome: null,
    startedAt: "now",
    endedAt: null,
  },
  card: claim.card,
  stage: claim.stage,
  handoff: null,
  references: [],
};
const dispatch = {
  ...key,
  stationId: station,
  agentKey: "proof",
  leaseEpoch: 1,
};
const plan = corpus.cases[0]!.payload.plan;
beforeAll(async () => {
  await ensurePgMigrations();
  fakePlane.addHuman({ id: user, grant: { mayDispatch: [principal] } });
  fakePlane.addAgent({ id: principal });
  for (const id of [user, principal])
    fakePlane.principals.get(id)!.organizationId = org;
  await db.insert(tenants).values({
    id: tenantId,
    name: "strict work proof",
    externalSource: "org-plane",
    externalId: org,
  });
  await db.insert(nodes).values({
    id: node,
    tenantId,
    userId: user,
    name: "proof",
    hostname: "fixture",
    os: "test",
    arch: "test",
    secretHash: "not-real",
  });
  await db.insert(stations).values({
    id: station,
    tenantId,
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
  await openDispatch(dispatch);
  const execution = await makeSalaamExecution(station, user, session, {
    source: "superpipeline",
    id: run,
    epoch: 1,
  });
  execution.sessionId = "local-session";
  execution.admissionId = "local-admission";
  await db.insert(acpSessions).values({
    id: session,
    tenantId,
    stationId: station,
    userId: user,
    mode: "ask",
    status: "idle",
    executionAuthority: execution,
    createdAt: new Date(),
    lastEventAt: new Date(),
  });
});
afterAll(async () => {
  await db
    .delete(salaamWorkReports)
    .where(
      eq(
        salaamWorkReports.workRequestId,
        (
          await db
            .select()
            .from(salaamWorkOwners)
            .where(eq(salaamWorkOwners.sessionId, session))
        )[0]?.requestId ?? "none",
      ),
    );
  await db
    .delete(salaamWorkDecisions)
    .where(
      eq(
        salaamWorkDecisions.workRequestId,
        (
          await db
            .select()
            .from(salaamWorkOwners)
            .where(eq(salaamWorkOwners.sessionId, session))
        )[0]?.requestId ?? "none",
      ),
    );
  await db
    .delete(salaamWorkOwners)
    .where(eq(salaamWorkOwners.tenantId, tenantId));
  await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenantId));
  await db
    .delete(bridgeDispatches)
    .where(eq(bridgeDispatches.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  fakePlane.remove(user);
  fakePlane.remove(principal);
});
test("concurrent reservations own one immutable request and reject changed claim/input/lease", async () => {
  const [a, b] = await Promise.all([
    reserveSalaamWork(session, user, claim, context, plan),
    reserveSalaamWork(session, user, claim, context, plan),
  ]);
  expect(a.requestId).toBe(b.requestId);
  await expect(
    reserveSalaamWork(
      session,
      user,
      claim,
      { ...context, card: { ...context.card, title: "changed" } },
      plan,
    ),
  ).rejects.toThrow(/changed/);
  await expect(
    reserveSalaamWork(session, "prn_" + hex(), claim, context, plan),
  ).rejects.toThrow(/owner/);
  await expect(openDispatch({ ...dispatch, leaseEpoch: 2 })).rejects.toThrow(
    /original owner/,
  );
  await expect(recordProduced(key, { text: "unverified" })).rejects.toThrow(
    /verified completion/,
  );
  await expect(
    findUnreportedOutput({ ...key, externalRunId: "run_" + hex() }),
  ).rejects.toThrow(/original run/);
});
test("lost admission reply retries original durable bytes; forged receipt is not cached", async () => {
  const row = await reserveSalaamWork(session, user, claim, context, plan);
  const payload = row.payload as (typeof corpus.cases)[0]["payload"];
  const receipt = {
    version: 1,
    state: "admitted",
    session_id: "local-session",
    task_id: "99999999-9999-4999-8999-999999999999",
    request_id: row.requestId,
    binding_digest: workDigest(payload.admission.binding),
    plan_revision: 1,
  };
  let calls = 0;
  const seen: unknown[] = [];
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, params) => {
      expect(_node).toBe(node);
      expect(verb).toBe("salaam.work-admit");
      seen.push(params);
      calls++;
      if (calls === 1) return { ok: false, error: "lost response" };
      return {
        ok: true,
        data: calls === 2 ? { ...receipt, session_id: "foreign" } : receipt,
      };
    },
  );
  try {
    await expect(deliverSalaamWork(session, user)).rejects.toThrow(
      /original request/,
    );
    await expect(deliverSalaamWork(session, user)).rejects.toThrow(
      /another owner/,
    );
    expect((await deliverSalaamWork(session, user)).task_id).toBe(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[1]).toEqual(seen[2]);
    await fakePlane.suspend(principal);
    expect((await deliverSalaamWork(session, user)).task_id).toBe(
      "99999999-9999-4999-8999-999999999999",
    );
    expect(calls).toBe(3); // cached admission is not a fresh grant
    await expect(deliverSalaamWork(session, "prn_" + hex())).rejects.toThrow(
      /unavailable/,
    );
  } finally {
    mock.mockRestore();
    await fakePlane.unsuspend(principal);
  }
});

test("owner payload joins cannot be removed and generic reporting stays denied", async () => {
  await expect(markReported(key)).rejects.toThrow(/verified original-run/);
  await expect(
    Promise.resolve(
      db
        .update(salaamWorkOwners)
        .set({ requestId: crypto.randomUUID() })
        .where(eq(salaamWorkOwners.sessionId, session)),
    ),
  ).rejects.toThrow();
  await expect(
    Promise.resolve(
      db
        .update(salaamWorkOwners)
        .set({ payload: {} })
        .where(eq(salaamWorkOwners.sessionId, session)),
    ),
  ).rejects.toThrow();
  await expect(
    Promise.resolve(db.delete(acpSessions).where(eq(acpSessions.id, session))),
  ).rejects.toThrow();
});

import {
  publishSalaamDecision,
  answerSalaamDecision,
} from "../../src/services/bridge/salaam-decisions";
import decisionFixture from "../../../../packages/contract/src/fixtures/salaam-work-decision-v1.json";
import { SalaamWorkDecision } from "../../../../packages/contract/src/salaam-work-decision";
test("strict question pins producer ID, tolerates response loss and never selects latest", async () => {
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, session));
  const payload = work!.payload as (typeof corpus.cases)[0]["payload"];
  const decision = SalaamWorkDecision.parse({
    ...decisionFixture.decision,
    request_id: crypto.randomUUID(),
    work_request_id: work!.requestId,
    binding_digest: workDigest(payload.admission.binding),
    task_id: "99999999-9999-4999-8999-999999999999",
    expires_at: Date.now() + 60000,
  });
  const strict = {
    version: 1 as const,
    request_id: decision.request_id,
    decision_digest: workDigest(decision),
    expires_at: decision.expires_at,
  };
  const producer = {
    accepted: true as const,
    cardState: "input-required" as const,
    elicitationId: "elc_abcdef",
    strictDecision: strict,
  };
  let posts = 0;
  const offers: unknown[] = [];
  const client = {
    activity: async (_lease: unknown, activity: unknown) => {
      offers.push(activity);
      if (++posts === 1) throw Error("lost producer reply");
      return producer;
    },
  };
  await expect(
    publishSalaamDecision(session, user, decision, client),
  ).rejects.toThrow(/lost producer reply/);
  expect(
    (await publishSalaamDecision(session, user, decision, client))
      .elicitationId,
  ).toBe("elc_abcdef");
  expect(offers[0]).toEqual(offers[1]);
  await publishSalaamDecision(session, user, decision, client);
  expect(posts).toBe(2);
  await expect(
    publishSalaamDecision(
      session,
      user,
      { ...decision, approval_revision: 2 },
      client,
    ),
  ).rejects.toThrow(/conflict/);
  const question = {
    id: producer.elicitationId,
    runId: run,
    cardId: card,
    stageKey: "build",
    question: decision.question,
    options: decision.options.map((v) => ({ name: v.id, title: v.title })),
    strictDecision: strict,
    status: "answered" as const,
    createdAt: new Date().toISOString(),
    answer: {
      option: "deny",
      text: null,
      answeredBy: user,
      answeredAt: new Date().toISOString(),
    },
  };
  const read = {
    context: async () => ({
      ...context,
      elicitations: [
        question,
        {
          ...question,
          id: "elc_newest",
          answer: { ...question.answer, option: "approve" },
        },
      ],
    }),
  };
  let sends = 0;
  const answers: any[] = [];
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, params) => {
      expect(verb).toBe("salaam.work-decision");
      const answer = (params as any).answer;
      answers.push(answer);
      if (++sends === 1) return { ok: false, error: "lost daemon reply" };
      return {
        ok: true,
        data: {
          version: 1,
          request_id: answer.request_id,
          decision_digest: answer.decision_digest,
          approval_id: decision.approval_id,
          decision: answer.option_id,
        },
      };
    },
  );
  try {
    await expect(
      answerSalaamDecision(session, user, decision.request_id, read),
    ).rejects.toThrow(/original answer/);
    const receipt = await answerSalaamDecision(
      session,
      user,
      decision.request_id,
      read,
    );
    expect((receipt as any).decision).toBe("deny");
    expect(answers[0]).toEqual(answers[1]);
    await answerSalaamDecision(session, user, decision.request_id, read);
    expect(sends).toBe(2);
    await db
      .update(salaamWorkDecisions)
      .set({
        daemonReceipt: {
          ...(receipt as object),
          approval_id: crypto.randomUUID(),
        },
      })
      .where(eq(salaamWorkDecisions.requestId, decision.request_id));
    await expect(
      answerSalaamDecision(session, user, decision.request_id, read),
    ).rejects.toThrow(/receipt mismatch/);
    await db
      .update(salaamWorkDecisions)
      .set({ daemonReceipt: receipt })
      .where(eq(salaamWorkDecisions.requestId, decision.request_id));
  } finally {
    mock.mockRestore();
  }
});
test("unsupported producer, mismatched question, expiry and revoked authority never grant", async () => {
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, session));
  const payload = work!.payload as (typeof corpus.cases)[0]["payload"];
  const decision = SalaamWorkDecision.parse({
    ...decisionFixture.decision,
    request_id: crypto.randomUUID(),
    work_request_id: work!.requestId,
    binding_digest: workDigest(payload.admission.binding),
    task_id: "99999999-9999-4999-8999-999999999999",
    expires_at: Date.now() + 60000,
  });
  let calls = 0;
  const unsupported = {
    activity: async () => {
      calls++;
      return { accepted: true, cardState: "input-required" };
    },
  };
  await expect(
    publishSalaamDecision(session, user, decision, unsupported),
  ).rejects.toThrow();
  await expect(
    publishSalaamDecision(
      session,
      user,
      {
        ...decision,
        request_id: crypto.randomUUID(),
        expires_at: Date.now() - 1,
      },
      unsupported,
    ),
  ).rejects.toThrow(/expired/);
  expect(calls).toBe(1);
  const strict = {
    version: 1 as const,
    request_id: decision.request_id,
    decision_digest: workDigest(decision),
    expires_at: decision.expires_at,
  };
  await publishSalaamDecision(session, user, decision, {
    activity: async () => ({
      accepted: true,
      cardState: "input-required",
      elicitationId: "elc_second",
      strictDecision: strict,
    }),
  });
  await expect(
    answerSalaamDecision(session, user, decision.request_id, {
      context: async () => ({ ...context, elicitations: [] }),
    }),
  ).rejects.toThrow(/binding/);
  await fakePlane.suspend(principal);
  try {
    await expect(
      answerSalaamDecision(session, user, decision.request_id, {
        context: async () => context,
      }),
    ).rejects.toThrow(/suspended/);
  } finally {
    await fakePlane.unsuspend(principal);
  }
});

import { reportSalaamCompletion } from "../../src/services/bridge/salaam-report";
async function reportFixture() {
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, session));
  await db
    .delete(salaamWorkDecisions)
    .where(eq(salaamWorkDecisions.workRequestId, work!.requestId));
  await db
    .update(salaamWorkOwners)
    .set({ settlement: null })
    .where(eq(salaamWorkOwners.requestId, work!.requestId));
  await db
    .delete(salaamWorkReports)
    .where(eq(salaamWorkReports.workRequestId, work!.requestId));
  await db
    .update(bridgeDispatches)
    .set({ outcome: "working", result: null })
    .where(eq(bridgeDispatches.externalRunId, run));
  const payload = work!.payload as (typeof corpus.cases)[0]["payload"];
  return {
    work: work!,
    completion: {
      version: 1,
      state: "verified",
      work_request_id: work!.requestId,
      task_id: "99999999-9999-4999-8999-999999999999",
      plan_revision: 1,
      binding_digest: workDigest(payload.admission.binding),
      completion_id: "artifact_completion_fixture",
      evidence_digest: "c".repeat(64),
    },
  };
}
test("lost complete response reconciles original run after revocation without another write", async () => {
  const { work, completion } = await reportFixture();
  let current: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  let writes = 0,
    checks = 0;
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb) => {
      expect(verb).toBe("salaam.work-completion");
      checks++;
      return { ok: true, data: completion };
    },
  );
  const client = {
    context: async (id: string) => {
      expect(id).toBe(run);
      return current;
    },
    completeVerified: async (
      lease: { runId: string; leaseEpoch: number },
      handoff: unknown,
    ) => {
      expect(lease).toEqual({ runId: run, leaseEpoch: 1 });
      writes++;
      current = {
        ...current,
        handoff: { laterCardOutput: true },
        run: {
          ...current.run,
          status: "ended",
          outcome: "completed",
          endedAt: new Date().toISOString(),
          handoff,
          completion: { met: true, outcome: "pass" },
        },
      };
      throw Error("lost board reply");
    },
  };
  try {
    await expect(reportSalaamCompletion(session, user, client)).rejects.toThrow(
      /lost board reply/,
    );
    expect(writes).toBe(1);
    expect(checks).toBe(2);
    await fakePlane.suspend(principal);
    expect((await reportSalaamCompletion(session, user, client)).state).toBe(
      "reported",
    );
    expect(writes).toBe(1);
    expect(checks).toBe(2);
    const [saved] = await db
      .select()
      .from(salaamWorkReports)
      .where(eq(salaamWorkReports.workRequestId, work.requestId));
    expect(saved?.state).toBe("reported");
    const changed = {
      ...current,
      run: { ...current.run, handoff: { otherRunOutput: true } },
    };
    await expect(
      reportSalaamCompletion(session, user, {
        ...client,
        context: async () => changed,
      }),
    ).rejects.toThrow(/conflicts/);
    await expect(
      reportSalaamCompletion(session, user, {
        ...client,
        context: async () => ({
          ...current,
          run: {
            ...current.run,
            completion: { met: true, outcome: "changes-needed" },
          },
        }),
      }),
    ).rejects.toThrow(/conflicts/);
  } finally {
    mock.mockRestore();
    await fakePlane.unsuspend(principal);
  }
});
test("changed fresh evidence, stale lease, old producer and HTTP success cannot report pass", async () => {
  const { completion } = await reportFixture();
  const current: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  let checks = 0,
    writes = 0;
  const mock = spyOn(broker, "request").mockImplementation(async () => ({
    ok: true,
    data:
      ++checks === 1
        ? completion
        : { ...completion, evidence_digest: "d".repeat(64) },
  }));
  const client = {
    context: async () => current,
    completeVerified: async () => {
      writes++;
      return { ok: true };
    },
  };
  try {
    await expect(reportSalaamCompletion(session, user, client)).rejects.toThrow(
      /completion changed/,
    );
    expect(writes).toBe(0);
    const [own] = await db
      .select()
      .from(salaamWorkOwners)
      .where(eq(salaamWorkOwners.sessionId, session));
    const [intent] = await db
      .select()
      .from(salaamWorkReports)
      .where(eq(salaamWorkReports.workRequestId, own!.requestId));
    if (!intent) throw Error("expected saved intent");
    const falseHandoff = { model: "looks good" };
    await db
      .update(salaamWorkReports)
      .set({ handoff: falseHandoff, handoffDigest: workDigest(falseHandoff) })
      .where(eq(salaamWorkReports.workRequestId, intent.workRequestId));
    await expect(reportSalaamCompletion(session, user, client)).rejects.toThrow(
      /handoff mismatch/,
    );
    await db
      .update(salaamWorkReports)
      .set({ handoff: intent.handoff, handoffDigest: intent.handoffDigest })
      .where(eq(salaamWorkReports.workRequestId, intent.workRequestId));
    await expect(
      reportSalaamCompletion(session, user, {
        ...client,
        context: async () => ({
          ...current,
          run: { ...current.run, leaseEpoch: 2 },
        }),
      }),
    ).rejects.toThrow(/binding changed/);
    await expect(
      reportSalaamCompletion(session, user, {
        ...client,
        context: async () => context,
      }),
    ).rejects.toThrow(/lacks original-run/);
    mock.mockImplementation(async () => ({ ok: true, data: completion }));
    await expect(reportSalaamCompletion(session, user, client)).rejects.toThrow(
      /conflicts/,
    );
    expect(writes).toBe(1);
    await expect(
      reportSalaamCompletion(session, "prn_" + hex(), client),
    ).rejects.toThrow(/owner unavailable/);
  } finally {
    mock.mockRestore();
  }
});
test("unverified or failed daemon work never creates report intent", async () => {
  const { work } = await reportFixture();
  const current: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  let writes = 0;
  const client = {
    context: async () => current,
    completeVerified: async () => {
      writes++;
    },
  };
  const mock = spyOn(broker, "request").mockImplementation(async () => ({
    ok: true,
    data: { state: "completed", text: "looks good" },
  }));
  try {
    await expect(
      reportSalaamCompletion(session, user, client),
    ).rejects.toThrow();
    mock.mockImplementation(async () => ({
      ok: false,
      error: "checks failed",
    }));
    await expect(reportSalaamCompletion(session, user, client)).rejects.toThrow(
      /Fresh protected/,
    );
    expect(writes).toBe(0);
    expect(
      (
        await db
          .select()
          .from(salaamWorkReports)
          .where(eq(salaamWorkReports.workRequestId, work.requestId))
      ).length,
    ).toBe(0);
  } finally {
    mock.mockRestore();
  }
});

import { runOnce, type DispatchDeps } from "../../src/services/bridge/dispatch";
import { probeSalaamWork } from "../../src/services/bridge/salaam-dispatch";
test("strict runtime capability missing or wrong version prevents claiming", async () => {
  let claims = 0;
  const mocked = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: { version: 2, enabled: true },
  } as never);
  try {
    const deps = {
      agent: { stationId: station, hubUserId: user },
      acp: { strictWork: probeSalaamWork },
      client: {
        claim: async () => {
          claims++;
          throw Error("must not claim");
        },
      },
    } as unknown as DispatchDeps;
    expect((await runOnce(deps)).status).toBe("not-ready");
    expect(claims).toBe(0);
  } finally {
    mocked.mockRestore();
  }
});
test("strict resumed task drives private bounded progression and verified reporting without new claim or ACP prompt", async () => {
  const { work, completion } = await reportFixture();
  const events: string[] = [];
  let live: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, body: any) => {
      events.push(verb);
      if (verb === "salaam.work-progress")
        return {
          ok: true,
          data: {
            version: 1,
            request_id: work.requestId,
            work_request_id: work.requestId,
            task_id: completion.task_id,
            plan_revision: 1,
            binding_digest: completion.binding_digest,
          },
        } as never;
      if (verb === "salaam.work-status")
        return {
          ok: true,
          data: { ...completion, state: "succeeded", auto_enabled: false },
        } as never;
      if (verb === "salaam.work-completion")
        return { ok: true, data: completion } as never;
      throw Error("Unexpected private verb: " + verb);
    },
  );
  try {
    const deps = {
      tenantId,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        context: async () => live,
        heartbeat: async () => {
          events.push("heartbeat");
        },
        completeVerified: async (_lease: unknown, handoff: unknown) => {
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
          events.push("verified-report");
          return { ok: true };
        },
        claim: async () => {
          throw Error("new claim forbidden");
        },
      },
      acp: {
        strictWork: async () => ({ required: true, version: 1 }),
        renewExecution: async () => {
          events.push("renew");
        },
        endSession: async () => {
          events.push("end");
        },
        promptSession: async () => {
          throw Error("generic prompt forbidden");
        },
      },
    } as unknown as DispatchDeps;
    expect(await runOnce(deps)).toMatchObject({ status: "reported" });
    expect(events.indexOf("heartbeat")).toBeLessThan(events.indexOf("renew"));
    expect(events.filter((x) => x === "salaam.work-progress")).toHaveLength(1);
    expect(events.filter((x) => x === "verified-report")).toHaveLength(1);
  } finally {
    mock.mockRestore();
  }
});

for (const lostVerb of ["salaam.work-progress", "salaam.work-status"]) {
  test(`strict controller recovers lost ${lostVerb} reply under original request`, async () => {
    const { work, completion } = await reportFixture();
    const requests: unknown[] = [];
    let lose = true,
      ended = 0,
      claims = 0,
      reported = 0;
    let live: RunContext = {
      ...context,
      run: { ...context.run, handoff: null, completion: null },
    };
    const mock = spyOn(broker, "request").mockImplementation(
      async (_node, verb, body: any) => {
        if (verb === "salaam.work-progress") requests.push(body);
        if (verb === lostVerb && lose) {
          lose = false;
          throw Error("accepted remotely; reply lost");
        }
        if (verb === "salaam.work-progress")
          return {
            ok: true,
            data: {
              version: 1,
              request_id: work.requestId,
              work_request_id: work.requestId,
              task_id: completion.task_id,
              plan_revision: 1,
              binding_digest: completion.binding_digest,
            },
          } as never;
        if (verb === "salaam.work-status")
          return {
            ok: true,
            data: { ...completion, state: "succeeded", auto_enabled: false },
          } as never;
        if (verb === "salaam.work-completion")
          return { ok: true, data: completion } as never;
        throw Error("unexpected verb");
      },
    );
    const deps = {
      tenantId,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        context: async () => live,
        heartbeat: async () => {},
        claim: async () => {
          claims++;
          throw Error("new claim forbidden");
        },
        completeVerified: async (_lease: unknown, handoff: unknown) => {
          reported++;
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
        renewExecution: async () => {},
        endSession: async () => {
          ended++;
        },
        promptSession: async () => {
          throw Error("generic prompt forbidden");
        },
      },
    } as unknown as DispatchDeps;
    try {
      expect(await runOnce(deps)).toMatchObject({
        status: "failed",
        reason: expect.stringContaining("reply lost"),
      });
      expect(ended).toBe(0);
      expect(reported).toBe(0);
      expect(await runOnce(deps)).toMatchObject({ status: "reported" });
      expect(claims).toBe(0);
      expect(reported).toBe(1);
      expect(ended).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(requests[1]);
    } finally {
      mock.mockRestore();
    }
  });
}
for (const code of ["STALE_LEASE", "NOT_RUN_OWNER"]) {
  test(`strict controller ${code} stops before renewal or progression`, async () => {
    await reportFixture();
    let renewals = 0,
      ends = 0,
      requests = 0;
    const mock = spyOn(broker, "request").mockImplementation(async () => {
      requests++;
      throw Error("must not dispatch");
    });
    const deps = {
      tenantId,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        context: async () => context,
        heartbeat: async () => {
          throw Object.assign(Error(code), { code });
        },
        claim: async () => {
          throw Error("new claim forbidden");
        },
      },
      acp: {
        strictWork: async () => ({ required: true, version: 1 }),
        renewExecution: async () => {
          renewals++;
        },
        endSession: async () => {
          ends++;
        },
      },
    } as unknown as DispatchDeps;
    try {
      expect(await runOnce(deps)).toMatchObject({
        status: "failed",
        reason: expect.stringContaining(code),
      });
      expect(renewals).toBe(0);
      expect(requests).toBe(0);
      expect(ends).toBe(1);
    } finally {
      mock.mockRestore();
    }
  });
}

test("strict lease loss after progression prevents status, completion and another renewal", async () => {
  const { work, completion } = await reportFixture();
  let beats = 0,
    renewals = 0,
    ends = 0;
  const verbs: string[] = [];
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb) => {
      verbs.push(verb);
      if (verb !== "salaam.work-progress")
        throw Error("post-loss dispatch forbidden");
      return {
        ok: true,
        data: {
          version: 1,
          request_id: work.requestId,
          work_request_id: work.requestId,
          task_id: completion.task_id,
          plan_revision: 1,
          binding_digest: completion.binding_digest,
        },
      } as never;
    },
  );
  const deps = {
    tenantId,
    source: "superpipeline",
    agent: {
      key: "proof",
      boardId: board,
      stationId: station,
      hubUserId: user,
    },
    client: {
      context: async () => context,
      heartbeat: async () => {
        if (++beats === 2)
          throw Object.assign(Error("lease reclaimed"), {
            code: "STALE_LEASE",
          });
      },
      claim: async () => {
        throw Error("new claim forbidden");
      },
    },
    acp: {
      strictWork: async () => ({ required: true, version: 1 }),
      renewExecution: async () => {
        renewals++;
      },
      endSession: async () => {
        ends++;
      },
    },
  } as unknown as DispatchDeps;
  try {
    expect(await runOnce(deps)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("lease reclaimed"),
    });
    expect(renewals).toBe(1);
    expect(ends).toBe(1);
    expect(verbs).toEqual(["salaam.work-progress"]);
  } finally {
    mock.mockRestore();
  }
});

test("durable work rows cannot cross the owning session tenant", async () => {
  const { work } = await reportFixture();
  const foreign = "fleet_" + hex();
  await db.insert(tenants).values({ id: foreign, name: "foreign tenant" });
  try {
    await expect(
      Promise.resolve(
        db
          .update(salaamWorkOwners)
          .set({ tenantId: foreign })
          .where(eq(salaamWorkOwners.requestId, work.requestId)),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        db.insert(salaamWorkDecisions).values({
          tenantId: foreign,
          requestId: crypto.randomUUID(),
          workRequestId: work.requestId,
          decision: {},
        }),
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(
        db.insert(salaamWorkReports).values({
          tenantId: foreign,
          requestId: crypto.randomUUID(),
          workRequestId: work.requestId,
          completion: {},
          handoff: {},
          handoffDigest: "a".repeat(64),
          state: "prepared",
        }),
      ),
    ).rejects.toThrow();
  } finally {
    await db.delete(tenants).where(eq(tenants.id, foreign));
  }
});

test("report rechecks authority after asynchronous credential acquisition", async () => {
  const { completion } = await reportFixture();
  let writes = 0;
  const mock = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: completion,
  } as never);
  try {
    await expect(
      reportSalaamCompletion(session, user, {
        context: async () => ({
          ...context,
          run: { ...context.run, handoff: null, completion: null },
        }),
        completeVerified: async (
          _lease: unknown,
          _handoff: unknown,
          beforeSend?: () => Promise<void>,
        ) => {
          await fakePlane.suspend(principal);
          expect(beforeSend).toBeDefined();
          await beforeSend!();
          writes++;
          return {};
        },
      }),
    ).rejects.toThrow(/suspended/);
    expect(writes).toBe(0);
  } finally {
    mock.mockRestore();
    await fakePlane.unsuspend(principal);
  }
});

import { startSalaamWork } from "../../src/services/bridge/salaam-dispatch";
for (const declared of [null, false, true]) {
  test(`strict session startup uses explicit MCP declaration ${declared} and settles confirmed release`, async () => {
    const runId = "run_" + hex();
    await db
      .update(stations)
      .set({ mcpProxy: declared })
      .where(eq(stations.id, station));
    let requested: boolean | undefined;
    let released = 0;
    const deps = {
      tenantId,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        context: async () => ({
          ...context,
          card: { ...context.card, spec: { salaam: { version: 1, plan } } },
        }),
        heartbeat: async () => {},
        release: async () => {
          released++;
        },
      },
      acp: {
        createSession: async (input: { mcpProxy: boolean }) => {
          requested = input.mcpProxy;
          throw Error("reviewed startup refused");
        },
      },
    } as unknown as DispatchDeps;
    expect(await startSalaamWork(deps, { ...claim, runId })).toMatchObject({
      status: "released",
      externalRunId: runId,
    });
    expect(requested).toBe(declared === true);
    expect(released).toBe(1);
    const [row] = await db
      .select()
      .from(bridgeDispatches)
      .where(eq(bridgeDispatches.externalRunId, runId));
    expect(row?.outcome).toBe("released");
    expect(row?.reason).toContain("reviewed startup refused");
    await db
      .delete(bridgeDispatches)
      .where(eq(bridgeDispatches.externalRunId, runId));
  });
}
test("unconfirmed strict release never records a released ledger outcome", async () => {
  const runId = "run_" + hex();
  const deps = {
    tenantId,
    source: "superpipeline",
    agent: {
      key: "proof",
      boardId: board,
      stationId: station,
      hubUserId: user,
    },
    client: {
      context: async () => ({
        ...context,
        card: { ...context.card, spec: { salaam: { version: 1, plan } } },
      }),
      heartbeat: async () => {},
      release: async () => {
        throw Error("release response lost");
      },
    },
    acp: {
      createSession: async () => {
        throw Error("startup refused");
      },
    },
  } as unknown as DispatchDeps;
  await expect(startSalaamWork(deps, { ...claim, runId })).rejects.toThrow(
    "release response lost",
  );
  const [row] = await db
    .select()
    .from(bridgeDispatches)
    .where(eq(bridgeDispatches.externalRunId, runId));
  expect(row?.outcome).toBe("working");
  await db
    .delete(bridgeDispatches)
    .where(eq(bridgeDispatches.externalRunId, runId));
});

import { reconcileUnopenedSalaamRelease } from "../../src/services/bridge/salaam-dispatch";
test("original released run reconciles only without a session or work owner", async () => {
  const runId = "run_" + hex();
  await openDispatch({ ...dispatch, externalRunId: runId });
  let released = false;
  const deps = {
    tenantId,
    source: "superpipeline",
    agent: {
      key: "proof",
      boardId: board,
      stationId: station,
      hubUserId: user,
    },
    client: {
      context: async () => ({
        ...context,
        run: {
          ...context.run,
          runId,
          status: released ? "ended" : "working",
          outcome: released ? "released" : null,
        },
      }),
    },
  } as unknown as DispatchDeps;
  expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(
    false,
  );
  released = true;
  const missingStage = {
    ...deps,
    client: {
      ...deps.client,
      context: async () => ({
        ...(await deps.client.context(runId)),
        stage: null,
      }),
    },
  } as unknown as DispatchDeps;
  expect(
    await reconcileUnopenedSalaamRelease(missingStage, runId, "build"),
  ).toBe(false);
  expect(await reconcileUnopenedSalaamRelease(deps, runId, "other")).toBe(
    false,
  );
  expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(true);
  expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(
    false,
  );
  await db
    .delete(bridgeDispatches)
    .where(eq(bridgeDispatches.externalRunId, runId));
  await reportFixture();
  await db
    .update(bridgeDispatches)
    .set({ outcome: "working" })
    .where(eq(bridgeDispatches.externalRunId, run));
  const owned = {
    ...deps,
    client: {
      context: async () => ({
        ...context,
        run: { ...context.run, status: "ended", outcome: "released" },
      }),
    },
  } as unknown as DispatchDeps;
  expect(await reconcileUnopenedSalaamRelease(owned, run, "build")).toBe(false);
});

test("failed create with a hidden terminal session needs exact stop receipt before abandonment", async () => {
  const runId = "run_" + hex(),
    sid = "acps_" + hex();
  const [template] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, session));
  if (!template?.executionAuthority) throw Error("missing test authority");
  const authority = structuredClone(template.executionAuthority);
  authority.binding = {
    ...authority.binding,
    hub_session_id: sid,
    run: { source: "superpipeline", id: runId, epoch: 1 },
  };
  authority.state = "revoked";
  authority.sessionId = crypto.randomUUID();
  authority.admissionId = crypto.randomUUID();
  authority.receipt = {
    admission_id: authority.admissionId,
    session_id: authority.sessionId,
    binding: authority.binding,
    binding_digest: workDigest(authority.binding),
    lease_sequence: 1,
    expires_at: 1,
    authorized: false,
    revoked: true,
    owned_execution_stopped: false,
    unresolved_operations: [],
    active_attempts: [],
    interrupted_attempts: [],
  };
  let released = false;
  const deps = {
    tenantId,
    source: "superpipeline",
    agent: {
      key: "proof",
      boardId: board,
      stationId: station,
      hubUserId: user,
    },
    client: {
      context: async () => ({
        ...context,
        card: { ...context.card, spec: { salaam: { version: 1, plan } } },
        run: {
          ...context.run,
          runId,
          status: released ? "ended" : "working",
          outcome: released ? "released" : null,
        },
      }),
      heartbeat: async () => {},
      release: async () => {
        released = true;
      },
    },
    acp: {
      createSession: async () => {
        await db.insert(acpSessions).values({
          ...template,
          id: sid,
          status: "ended",
          executionAuthority: authority,
        });
        throw Error("startup refused after row persisted");
      },
    },
  } as unknown as DispatchDeps;
  try {
    expect(await startSalaamWork(deps, { ...claim, runId })).toMatchObject({
      status: "failed",
    });
    expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(
      false,
    );
    authority.receipt.owned_execution_stopped = true;
    authority.receipt.binding_digest = "bad";
    await db
      .update(acpSessions)
      .set({ executionAuthority: authority })
      .where(eq(acpSessions.id, sid));
    expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(
      false,
    );
    authority.receipt.binding_digest = workDigest(authority.binding);
    await db
      .update(acpSessions)
      .set({ executionAuthority: authority })
      .where(eq(acpSessions.id, sid));
    expect(await reconcileUnopenedSalaamRelease(deps, runId, "build")).toBe(
      true,
    );
    const [saved] = await db
      .select()
      .from(bridgeDispatches)
      .where(eq(bridgeDispatches.externalRunId, runId));
    expect(saved?.outcome).toBe("abandoned");
  } finally {
    await db.delete(acpSessions).where(eq(acpSessions.id, sid));
    await db
      .delete(bridgeDispatches)
      .where(eq(bridgeDispatches.externalRunId, runId));
  }
});

import {
  settleNeverDispatchedSalaamWork,
  resumeSalaamWork,
  recoverExpiredSalaamDecision,
} from "../../src/services/bridge/salaam-dispatch";
test.each([
  "crashed",
  "reclaimed",
  "known-effects",
  "unreported-local-success",
])(
  "explicit terminal settlement retains original %s owner across lost replies and later leases",
  async (terminalOutcome) => {
    const { work, completion } = await reportFixture();
    const [originalSession] = await db
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.id, session));
    if (!originalSession?.executionAuthority) throw Error("missing authority");
    const authority = structuredClone(originalSession.executionAuthority);
    authority.state = "revoked";
    authority.sessionId = crypto.randomUUID();
    authority.admissionId = crypto.randomUUID();
    authority.receipt = {
      admission_id: authority.admissionId,
      session_id: authority.sessionId,
      binding: authority.binding,
      binding_digest: workDigest(authority.binding),
      lease_sequence: 1,
      expires_at: 1,
      authorized: false,
      revoked: true,
      owned_execution_stopped: true,
      unresolved_operations: [],
      active_attempts: [],
      interrupted_attempts:
        terminalOutcome === "known-effects" ? ["historical-interrupted"] : [],
    };
    await db
      .update(acpSessions)
      .set({ status: "ended", executionAuthority: authority })
      .where(eq(acpSessions.id, session));
    await db
      .update(salaamWorkOwners)
      .set({
        settlement: null,
        receipt: { task_id: completion.task_id, plan_revision: 1 },
      })
      .where(eq(salaamWorkOwners.requestId, work.requestId));
    let live = { ...context, run: { ...context.run } },
      fails = 0,
      daemonCalls = 0;
    if (terminalOutcome === "reclaimed")
      live = {
        ...live,
        card: { ...live.card, currentRunId: "run_successor" },
        run: {
          ...live.run,
          status: "ended",
          outcome: "reclaimed",
          endedAt: "2026-10-20T18:00:00.000Z",
        },
      } as typeof live;
    const expectedFails = terminalOutcome === "reclaimed" ? 0 : 1;
    const request = crypto.randomUUID();
    const deps = {
      tenantId,
      source: "superpipeline",
      agent: {
        key: "proof",
        boardId: board,
        stationId: station,
        hubUserId: user,
      },
      client: {
        context: async () => live,
        fail: async () => {
          fails++;
          live = {
            ...live,
            run: {
              ...live.run,
              status: "ended",
              outcome: ["known-effects", "unreported-local-success"].includes(
                terminalOutcome,
              )
                ? "crashed"
                : terminalOutcome,
              endedAt: "2026-10-20T18:00:00.000Z",
            },
          };
          throw Error("lost producer reply");
        },
      },
    } as unknown as DispatchDeps;
    const mock = spyOn(broker, "request").mockImplementation(
      async (_node, verb, body: any) => {
        expect(verb).toBe(
          terminalOutcome === "unreported-local-success"
            ? "salaam.work-abandon"
            : terminalOutcome === "known-effects"
              ? "salaam.work-fail"
              : "salaam.work-settle",
        );
        daemonCalls++;
        if (daemonCalls === 1)
          return { ok: false, error: "lost daemon reply" } as never;
        return {
          ok: true,
          data: {
            version: 1,
            ...(terminalOutcome === "unreported-local-success"
              ? {
                  state: "retired",
                  outcome: "unreported_local_success",
                  evidence_digest: "a".repeat(64),
                }
              : {
                  state: "cancelled",
                  effects:
                    terminalOutcome === "known-effects"
                      ? "known_effects_preserved"
                      : "never_dispatched",
                  ...(terminalOutcome === "known-effects"
                    ? { evidence_digest: "a".repeat(64) }
                    : {}),
                }),
            request_id: request,
            work_request_id: work.requestId,
            session_id: authority.sessionId,
            task_id: completion.task_id,
            plan_revision: 1,
            binding_digest: workDigest(authority.binding),
            producer_terminal_digest: body.producer_terminal_digest,
          },
        } as never;
      },
    );
    const settle = (id: string) =>
      settleNeverDispatchedSalaamWork(
        deps,
        run,
        id,
        undefined,
        terminalOutcome === "known-effects",
        terminalOutcome === "unreported-local-success",
      );
    try {
      if (terminalOutcome === "unreported-local-success") {
        expect((await resumeSalaamWork(deps))?.reason).toContain(
          "revoked before report intent",
        );
        expect(
          (
            await db
              .select()
              .from(bridgeDispatches)
              .where(eq(bridgeDispatches.externalRunId, run))
          )[0]?.reason,
        ).toContain("explicit original-run reconciliation");
        await db
          .insert(salaamWorkReports)
          .values({
            workRequestId: work.requestId,
            tenantId,
            requestId: crypto.randomUUID(),
            completion,
            handoff: { historical: true },
            handoffDigest: "a".repeat(64),
            state: "prepared",
          });
        await expect(settle(request)).rejects.toThrow("Prepared report");
        expect(fails).toBe(0);
        expect(daemonCalls).toBe(0);
        await db
          .delete(salaamWorkReports)
          .where(eq(salaamWorkReports.workRequestId, work.requestId));
      }
      if (terminalOutcome === "known-effects")
        await expect(
          settleNeverDispatchedSalaamWork(deps, run, request),
        ).rejects.toThrow("stopped work owner");
      await expect(settle(request)).rejects.toThrow("unresolved");
      expect(fails).toBe(expectedFails);
      await expect(settle(crypto.randomUUID())).rejects.toThrow(
        "Original settlement",
      );
      const result = await settle(request);
      expect(result.state).toBe(
        terminalOutcome === "unreported-local-success"
          ? "retired"
          : "cancelled",
      );
      expect(await settle(request)).toEqual(result);
      expect(fails).toBe(expectedFails);
      expect(await resumeSalaamWork(deps)).toBe(null);
      expect(
        await db
          .select()
          .from(salaamWorkOwners)
          .where(eq(salaamWorkOwners.requestId, work.requestId)),
      ).toHaveLength(1);
      expect(
        (
          await db
            .select()
            .from(bridgeDispatches)
            .where(eq(bridgeDispatches.externalRunId, run))
        )[0]?.outcome,
      ).toBe("abandoned");
      live = { ...live, run: { ...live.run, leaseEpoch: 2 } };
      await expect(settle(request)).rejects.toThrow("run changed");
      authority.receipt.owned_execution_stopped = false;
      await db
        .update(acpSessions)
        .set({ executionAuthority: authority })
        .where(eq(acpSessions.id, session));
      await expect(settle(request)).rejects.toThrow("stopped work owner");
    } finally {
      mock.mockRestore();
      await db
        .update(acpSessions)
        .set({
          status: originalSession.status,
          executionAuthority: originalSession.executionAuthority,
        })
        .where(eq(acpSessions.id, session));
    }
  },
);

test("expired lost question receipt is recovered by exact original GET without posting or delivering approval", async () => {
  const { work, completion } = await reportFixture();
  const payload = work.payload as (typeof corpus.cases)[0]["payload"];
  const decision = SalaamWorkDecision.parse({
    ...decisionFixture.decision,
    request_id: crypto.randomUUID(),
    work_request_id: work.requestId,
    task_id: completion.task_id,
    binding_digest: workDigest(payload.admission.binding),
    expires_at: Date.now() - 1000,
  });
  const strictDecision = {
    version: 1 as const,
    request_id: decision.request_id,
    decision_digest: workDigest(decision),
    expires_at: decision.expires_at,
  };
  const question = {
    id: "elc_expired",
    runId: run,
    cardId: card,
    stageKey: "build",
    question: decision.question,
    signal: "select",
    options: decision.options.map((v) => ({ name: v.id, title: v.title })),
    strictDecision,
    status: "pending" as const,
    answer: null,
    createdAt: new Date().toISOString(),
  };
  let posts = 0;
  const client = {
    activity: async () => {
      posts++;
      throw Error("must not post expired offer");
    },
    context: async () => ({ ...context, elicitations: [question] }),
  };
  expect(
    (await publishSalaamDecision(session, user, decision, client))
      .elicitationId,
  ).toBe(question.id);
  expect(posts).toBe(0);
  await expect(
    answerSalaamDecision(session, user, decision.request_id, client),
  ).rejects.toThrow(/expired/);
  const [saved] = await db
    .select()
    .from(salaamWorkDecisions)
    .where(eq(salaamWorkDecisions.requestId, decision.request_id));
  expect(saved?.answer).toBeNull();
  expect(saved?.daemonReceipt).toBeNull();
  const another = { ...decision, request_id: crypto.randomUUID() };
  await expect(
    publishSalaamDecision(session, user, another, client),
  ).rejects.toThrow(/historical binding/);
  // Remove only the deliberately mismatched test request; original stays durable.
  await db
    .delete(salaamWorkDecisions)
    .where(eq(salaamWorkDecisions.requestId, another.request_id));
  let live = { ...context, elicitations: [question] },
    fails = 0,
    calls = 0;
  const [before] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, session));
  const authority = structuredClone(before!.executionAuthority!);
  const daemonSessionId = crypto.randomUUID(),
    daemonAdmissionId = crypto.randomUUID();
  authority.sessionId = daemonSessionId;
  authority.admissionId = daemonAdmissionId;
  const deps = {
    tenantId,
    source: "superpipeline",
    agent: {
      key: "proof",
      boardId: board,
      stationId: station,
      hubUserId: user,
    },
    client: {
      ...client,
      context: async () => live,
      fail: async () => {
        fails++;
        live = {
          ...live,
          run: {
            ...live.run,
            status: "ended",
            outcome: "crashed",
            endedAt: new Date().toISOString(),
          },
        };
        throw Error("lost failure response");
      },
    },
    acp: {
      endSession: async () => {
        authority.state = "revoked";
        authority.receipt = {
          admission_id: daemonAdmissionId,
          session_id: daemonSessionId,
          binding: authority.binding,
          binding_digest: workDigest(authority.binding),
          lease_sequence: 1,
          expires_at: 1,
          authorized: false,
          revoked: true,
          owned_execution_stopped: true,
          active_attempts: [],
          interrupted_attempts: [],
          unresolved_operations: [],
        };
        await db
          .update(acpSessions)
          .set({ status: "ended", executionAuthority: authority })
          .where(eq(acpSessions.id, session));
      },
    },
  } as unknown as DispatchDeps;
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, body: any) => {
      expect(verb).toBe("salaam.work-expire");
      expect(body.decision_request_id).toBe(decision.request_id);
      if (++calls === 1)
        return { ok: false, error: "lost expiry response" } as never;
      return {
        ok: true,
        data: {
          version: 1,
          state: "cancelled",
          effects: "expired_approval_unapplied",
          request_id: decision.request_id,
          work_request_id: work.requestId,
          decision_request_id: decision.request_id,
          approval_id: decision.approval_id,
          operation_digest: decision.operation_digest,
          session_id: daemonSessionId,
          task_id: completion.task_id,
          plan_revision: 1,
          binding_digest: workDigest(authority.binding),
          producer_terminal_digest: body.producer_terminal_digest,
        },
      } as never;
    },
  );
  try {
    await expect(recoverExpiredSalaamDecision(deps, session)).rejects.toThrow(
      /unresolved/,
    );
    expect((await recoverExpiredSalaamDecision(deps, session))?.status).toBe(
      "failed",
    );
    expect(fails).toBe(1);
    expect(posts).toBe(0);
    expect(await resumeSalaamWork(deps)).toBeNull();
    const [owner] = await db
      .select()
      .from(salaamWorkOwners)
      .where(eq(salaamWorkOwners.requestId, work.requestId));
    expect(owner).toBeDefined();
  } finally {
    mock.mockRestore();
    await db
      .update(acpSessions)
      .set({
        status: before!.status,
        executionAuthority: before!.executionAuthority,
      })
      .where(eq(acpSessions.id, session));
  }
});
