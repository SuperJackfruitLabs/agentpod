/** Synthetic plane + real owned Postgres; no model or deployed station. */
import { describe, beforeAll, afterAll, expect, test, spyOn } from "bun:test";
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
// What the publisher returns for a verified run: the agent's handoff and a published deliverable.
const publication = {
  agent: { summary: "Quoted RFC 9110 15.6.3", findings: ["502 means an invalid upstream response"] },
  deliverables: [
    { path: "answer.md", sha256: "c".repeat(64), url: "https://app.lib.test/a/itm_0123456789abcdef" },
  ],
  publication: "published" as const,
  library: { item_id: "itm_0123456789abcdef", url: "https://app.lib.test/a/itm_0123456789abcdef", export_id: "e" },
};
import { probeSalaamWork } from "../../src/services/bridge/salaam-dispatch";
test("strict runtime capability missing or wrong version prevents claiming", async () => {
  let claims = 0;
  const mocked = spyOn(broker, "request").mockResolvedValue({
    ok: true,
    data: { version: 2, enabled: true },
  } as never);
  try {
    const deps = {
      tenantId,
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
  let progressSteps: unknown;
  const events: string[] = [];
  let live: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  const mock = spyOn(broker, "request").mockImplementation(
    async (_node, verb, body: any) => {
      events.push(verb);
      if (verb === "salaam.work-progress") progressSteps = body.max_steps;
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
      salaamPublish: async () => publication,
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
    // The grant is the plan's steps plus the capped re-run allowance (429 retries, critic reopens).
    expect(progressSteps).toBe((work.payload as { plan: { steps: unknown[] } }).plan.steps.length + 3);
    expect(events.filter((x) => x === "verified-report")).toHaveLength(1);
    // The board gets the agent's own handoff, the published deliverable, and Salaam's proof.
    const reported = live.run.handoff as Record<string, any>;
    expect(reported.summary).toBe(publication.agent.summary);
    expect(reported.findings).toEqual(publication.agent.findings);
    expect(reported.deliverables).toEqual(publication.deliverables);
    expect(reported.library).toEqual(publication.library);
    expect(reported.publication).toBe("published");
    expect(reported.verification).toMatchObject({ version: 1, source: "salaam", completion });
  } finally {
    mock.mockRestore();
  }
});

test("strict work posts each tool step to the card once, as card actions, while it runs", async () => {
  const { work, completion } = await reportFixture();
  const events: string[] = [];
  const posted: unknown[] = [];
  let polls = 0;
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
      if (verb === "salaam.work-decisions")
        return { ok: true, data: { version: 1, decisions: [] } } as never;
      if (verb === "salaam.work-status") {
        polls++;
        const step = (seq: number, phase: string, id: string) => ({
          seq,
          phase,
          tool_call_id: id,
          title: "fetch · fetch",
          kind: phase === "started" ? "fetch" : null,
          input: phase === "started" ? JSON.stringify({ url: "https://x" }) : null,
          failed: false,
        });
        const activity =
          polls === 1
            ? [step(1, "started", "a")]
            : [step(1, "started", "a"), step(2, "finished", "a"), step(3, "started", "b")];
        return {
          ok: true,
          data: {
            ...completion,
            state: polls < 3 ? "running" : "succeeded",
            auto_enabled: true,
            activity,
            plan: {
              sessionUpdate: "plan",
              entries: [{ content: "Research", priority: "medium", status: polls === 1 ? "pending" : "in_progress" }],
            },
          },
        } as never;
      }
      if (verb === "salaam.work-completion")
        return { ok: true, data: completion } as never;
      throw Error("Unexpected private verb: " + verb);
    },
  );
  try {
    const deps = {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
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
        activity: async (_lease: unknown, activity: unknown) => {
          posted.push(activity);
          if (posted.length === 2) throw Error("board briefly unavailable");
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
    (deps as unknown as { permissionPollMs: number }).permissionPollMs = 1;
    expect(await runOnce(deps)).toMatchObject({ status: "reported" });
    // An activity post that fails is not retried and cannot fail the work.
    // The plan comes first, before any step ran, and again when it changed.
    expect(posted).toEqual([
      { type: "thought", body: "Plan:\n1. Research (pending)" },
      { type: "action", action: "fetch · fetch", parameter: { url: "https://x" } },
      { type: "thought", body: "Plan:\n1. Research (in progress)" },
      { type: "action", action: "fetch · fetch", parameter: { url: "https://x" } },
    ]);
    expect(polls).toBe(3);
    expect(events.indexOf("heartbeat")).toBeLessThan(events.indexOf("renew"));
    expect(events.filter((x) => x === "salaam.work-progress")).toHaveLength(1);
    expect(events.filter((x) => x === "verified-report")).toHaveLength(1);
  } finally {
    mock.mockRestore();
  }
});

test("two pending strict decisions reach the board one at a time, oldest first", async () => {
  const { work, completion } = await reportFixture();
  const payload = work.payload as (typeof corpus.cases)[0]["payload"];
  const offer = (expires_at: number) =>
    SalaamWorkDecision.parse({
      ...decisionFixture.decision,
      request_id: crypto.randomUUID(),
      work_request_id: work.requestId,
      binding_digest: workDigest(payload.admission.binding),
      task_id: completion.task_id,
      plan_revision: completion.plan_revision,
      expires_at,
    });
  const older = offer(Date.now() + 60000),
    newer = offer(Date.now() + 120000);
  const offered: string[] = [];
  const questions: unknown[] = [];
  let polls = 0;
  let live: RunContext = {
    ...context,
    run: { ...context.run, handoff: null, completion: null },
  };
  const mock = spyOn(broker, "request").mockImplementation(async (_node, verb) => {
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
    if (verb === "salaam.work-status") {
      polls++;
      return {
        ok: true,
        data: {
          ...completion,
          state: polls < 3 ? "waiting_for_person" : "succeeded",
          auto_enabled: true,
        },
      } as never;
    }
    if (verb === "salaam.work-decisions")
      // Newest first on purpose: the bridge must not take Salaam's order as given.
      return { ok: true, data: { version: 1, decisions: [newer, older] } } as never;
    if (verb === "salaam.work-completion") return { ok: true, data: completion } as never;
    throw Error("Unexpected private verb: " + verb);
  });
  try {
    const deps = {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
      permissionPollMs: 1,
      agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
      client: {
        context: async () => ({ ...live, elicitations: questions }),
        heartbeat: async () => {},
        activity: async (_lease: unknown, activity: any) => {
          if (!activity.strictDecision) return { ok: true };
          offered.push(activity.strictDecision.request_id);
          const id = "elc_" + activity.strictDecision.request_id.slice(0, 8);
          questions.push({
            id,
            runId: live.run.runId,
            cardId: live.run.cardId,
            stageKey: live.run.stageKey,
            question: activity.body,
            options: activity.parameter.options,
            strictDecision: activity.strictDecision,
            status: "pending",
            createdAt: new Date().toISOString(),
          });
          return {
            accepted: true,
            cardState: "input-required",
            elicitationId: id,
            strictDecision: activity.strictDecision,
          };
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
          return { ok: true };
        },
        claim: async () => {
          throw Error("new claim forbidden");
        },
      },
      acp: {
        strictWork: async () => ({ required: true, version: 1 }),
        renewExecution: async () => {},
        endSession: async () => {},
      },
    } as unknown as DispatchDeps;
    expect(await runOnce(deps)).toMatchObject({ status: "reported" });
    // Both polls saw two pending decisions; only the older one was ever offered.
    expect(polls).toBe(3);
    expect(offered).toEqual([older.request_id]);
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
      salaamPublish: async () => publication,
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
      salaamPublish: async () => publication,
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
    salaamPublish: async () => publication,
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
      salaamPublish: async () => publication,
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
    salaamPublish: async () => publication,
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
    salaamPublish: async () => publication,
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
    salaamPublish: async () => publication,
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
      salaamPublish: async () => publication,
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
      // #786: a verified settlement is skipped whatever the dispatch outcome (run_bab4c853 kept
      // its settlement but stayed "working", and was re-driven forever).
      await db.update(bridgeDispatches).set({ outcome: "working" }).where(eq(bridgeDispatches.externalRunId, run));
      expect(await resumeSalaamWork(deps)).toBe(null);
      await db.update(bridgeDispatches).set({ outcome: "abandoned" }).where(eq(bridgeDispatches.externalRunId, run));
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
    salaamPublish: async () => publication,
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

test("execution evidence keeps original task and binding after lease expiry without renew or new grants", async () => {
  const { readExecutionEvidence } =
    await import("../../src/services/evidence/execution");
  const { ExecutionEvidenceBinding } =
    await import("../../../../packages/contract/src/execution-evidence");
  const fixture =
    await import("../../../../packages/contract/src/fixtures/execution-evidence-v1.json");
  const [owner] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.externalRunId, run));
  const [savedSession] = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, session));
  const payload = owner!.payload as (typeof corpus.cases)[0]["payload"];
  const receipt = owner!.receipt as { task_id: string; session_id: string };
  const authority = structuredClone(savedSession!.executionAuthority!);
  authority.state = "revoked";
  authority.sessionId = crypto.randomUUID();
  const evidence = structuredClone(fixture.default.success[0]!.value);
  const { workspace: _workspace, ...binding } = payload.admission.binding;
  evidence.binding = ExecutionEvidenceBinding.parse(binding);
  Object.assign(evidence.task, payload.admission.work, {
    task_id: receipt.task_id,
    request_id: owner!.requestId,
    session_id: authority.sessionId,
  });
  evidence.usage.session_id = authority.sessionId;
  await db
    .update(acpSessions)
    .set({ executionAuthority: authority, status: "ended" })
    .where(eq(acpSessions.id, session));
  await db
    .update(salaamWorkOwners)
    .set({ receipt: { ...receipt, session_id: authority.sessionId } })
    .where(eq(salaamWorkOwners.requestId, owner!.requestId));
  let calls = 0;
  const mock = spyOn(broker, "request").mockImplementation(
    async (target, verb, params) => {
      calls++;
      expect(target).toBe(node);
      expect(verb).toBe("salaam.work-evidence");
      expect(params).toEqual({ binding: payload.admission.binding });
      return { ok: true, data: evidence };
    },
  );
  try {
    expect(
      (
        await readExecutionEvidence(tenantId, "superpipeline", run, board, card)
      )[0]!.task.task_id,
    ).toBe(receipt.task_id);
    evidence.binding.run.epoch++;
    await expect(
      readExecutionEvidence(tenantId, "superpipeline", run, board, card),
    ).rejects.toThrow("execution_binding_mismatch");
    evidence.binding.run.epoch--;
    evidence.task.task_id = crypto.randomUUID();
    await expect(
      readExecutionEvidence(tenantId, "superpipeline", run, board, card),
    ).rejects.toThrow("execution_task_mismatch");
    expect(
      await readExecutionEvidence(
        "fleet_foreign",
        "superpipeline",
        run,
        board,
        card,
      ),
    ).toEqual([]);
    expect(calls).toBe(3);
    evidence.task.task_id = receipt.task_id;
    const { readExecutionArtifactBundle } =
      await import("../../src/services/evidence/execution");
    const { evidenceHash } =
      await import("../../src/services/superlibrary/execution-export");
    const content = Buffer.from("actual immutable selected patch");
    const artifact = {
      id: crypto.randomUUID(),
      session_id: authority.sessionId,
      digest: evidenceHash(content),
      bytes: content.length,
      disposition: "produced" as const,
    };
    evidence.artifacts = [artifact];
    const bundle = {
      schema_version: "salaam-execution-artifacts/v1",
      evidence,
      artifacts: [{ ...artifact, content_base64: content.toString("base64") }],
    };
    mock.mockImplementation(async (_node, verb, params: any) => {
      expect(verb).toBe("salaam.work-evidence-artifacts");
      expect(params.artifact_ids).toEqual([artifact.id]);
      return { ok: true, data: bundle };
    });
    expect(
      (
        await readExecutionArtifactBundle(
          tenantId,
          "superpipeline",
          run,
          board,
          card,
          [artifact.id],
        )
      ).artifacts[0]!.digest,
    ).toBe(artifact.digest);
    bundle.artifacts[0]!.content_base64 =
      Buffer.from("tampered").toString("base64");
    await expect(
      readExecutionArtifactBundle(tenantId, "superpipeline", run, board, card, [
        artifact.id,
      ]),
    ).rejects.toThrow("source_artifact_integrity_failed");
  } finally {
    mock.mockRestore();
    await db
      .update(acpSessions)
      .set({
        executionAuthority: savedSession!.executionAuthority,
        status: savedSession!.status,
      })
      .where(eq(acpSessions.id, session));
    await db
      .update(salaamWorkOwners)
      .set({ receipt: owner!.receipt })
      .where(eq(salaamWorkOwners.requestId, owner!.requestId));
  }
});

import { planFrom, settleStoppedSalaamWork } from "../../src/services/bridge/salaam-dispatch";
test("the admitted plan is the card's plan scoped to this run's own directory", () => {
  const spec = { salaam: { version: 1, plan } };
  const admitted = planFrom({ ...context, card: { ...context.card, spec } } as RunContext);
  const dir = "runs/" + context.run.runId + "/";
  expect(admitted.deliverables.length).toBe(plan.deliverables.length + 1);
  expect(admitted.deliverables.every((d) => d.startsWith(dir))).toBe(true);
  expect(admitted.deliverables).toContain(dir + "handoff.json");
  // Station checks run at the workspace root; each command enters the run directory itself.
  expect(admitted.acceptance.every((c) => c.cwd === "." && c.command.startsWith(`cd '${dir.replace(/\/$/, "")}`))).toBe(true);
  const other = planFrom({
    ...context,
    run: { ...context.run, runId: "run_" + hex() },
    card: { ...context.card, spec },
  } as RunContext);
  for (const d of admitted.deliverables) expect(other.deliverables).not.toContain(d);
});

// #786: a revoked strict run that never reported must not hold its roster forever.
describe("resume parks a revoked unreported run and skips settled ones", () => {
  async function revoke() {
    const [original] = await db.select().from(acpSessions).where(eq(acpSessions.id, session));
    if (!original?.executionAuthority) throw Error("missing authority");
    const authority = structuredClone(original.executionAuthority);
    authority.state = "revoked";
    await db
      .update(acpSessions)
      .set({ status: "ended", executionAuthority: authority })
      .where(eq(acpSessions.id, session));
    return async () =>
      db
        .update(acpSessions)
        .set({ status: original.status, executionAuthority: original.executionAuthority })
        .where(eq(acpSessions.id, session));
  }
  const dispatchRow = async () =>
    (await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, run)))[0]!;
  function depsWith(activities: unknown[]) {
    return {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
      agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
      client: {
        context: async () => context,
        activity: async (_lease: unknown, a: unknown) => {
          activities.push(a);
          return { accepted: true };
        },
      },
    } as unknown as DispatchDeps;
  }

  test("a revoked run with no report is parked once, surfaced once, and no longer blocks a claim", async () => {
    await reportFixture();
    const restore = await revoke();
    const activities: unknown[] = [];
    const deps = depsWith(activities);
    try {
      const first = await resumeSalaamWork(deps);
      expect(first?.reason).toContain("revoked before report intent");
      const row = await dispatchRow();
      expect(row.outcome).toBe("parked");
      expect(row.reason).toContain("explicit original-run reconciliation");
      expect(activities).toHaveLength(1);
      expect(JSON.stringify(activities[0])).toContain("operator reconciliation");
      // The roster may claim again, and the run is not surfaced a second time.
      expect(await resumeSalaamWork(deps)).toBeNull();
      expect(await resumeSalaamWork(deps)).toBeNull();
      expect(activities).toHaveLength(1);
      // Parking settles nothing and completes nothing.
      const [owner] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.sessionId, session));
      expect(owner?.settlement).toBeNull();
      expect(
        await db.select().from(salaamWorkReports).where(eq(salaamWorkReports.workRequestId, owner!.requestId)),
      ).toHaveLength(0);
    } finally {
      await restore();
      await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
    }
  });

  test("only a working dispatch is parked; an abandoned one keeps its outcome", async () => {
    await reportFixture();
    const restore = await revoke();
    await db.update(bridgeDispatches).set({ outcome: "abandoned" }).where(eq(bridgeDispatches.externalRunId, run));
    const activities: unknown[] = [];
    try {
      await resumeSalaamWork(depsWith(activities));
      expect((await dispatchRow()).outcome).toBe("abandoned");
      expect(activities).toHaveLength(0);
    } finally {
      await restore();
      await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
    }
  });

  test("a live (not revoked) run is still resumed, and never parked", async () => {
    await reportFixture();
    const activities: unknown[] = [];
    const deps = depsWith(activities);
    const mock = spyOn(broker, "request").mockImplementation(async () => ({ ok: false, error: "fixture" }) as never);
    try {
      const result = await resumeSalaamWork(deps);
      expect(result).not.toBeNull();
      expect((await dispatchRow()).outcome).toBe("working");
    } finally {
      mock.mockRestore();
    }
  });

  test("a parked run can still be settled by the operator", async () => {
    await reportFixture();
    const restore = await revoke();
    const deps = depsWith([]);
    try {
      await resumeSalaamWork(deps);
      expect((await dispatchRow()).outcome).toBe("parked");
      // Settlement reads the stopped owner, not the dispatch outcome: parking does not lock it.
      await expect(settleNeverDispatchedSalaamWork(deps, run, crypto.randomUUID())).rejects.not.toThrow("parked");
    } finally {
      await restore();
      await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
    }
  });
});

test("a re-drive waits, delivering nothing, while the station's node is not connected", async () => {
  await reportFixture();
  const calls: string[] = [];
  const mock = spyOn(broker, "request").mockImplementation(async (_n, verb) => {
    calls.push(String(verb));
    return { ok: false, error: "fixture" } as never;
  });
  const deps = {
    tenantId,
    source: "superpipeline",
    salaamPublish: async () => publication,
    agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
    acp: { ensureStrictSession: async () => "waiting", renewExecution: async () => {} },
    client: { context: async () => context, heartbeat: async () => ({}) },
  } as unknown as DispatchDeps;
  try {
    const result = await resumeSalaamWork(deps);
    expect(result).toMatchObject({ status: "idle" });
    expect(String(result?.reason)).toContain("station node");
    expect(calls).toEqual([]);
  } finally {
    mock.mockRestore();
  }
});

test("a strict question carries the decision's readable detail to the producer as structured fields", async () => {
  const [work] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.sessionId, session));
  const payload = work!.payload as (typeof corpus.cases)[0]["payload"];
  const detail = {
    version: 1,
    summary: "Create runs/run_x/answer.md in the workspace",
    reason: "Write the quoted sentence the card asks for.",
    files: [{ path: "runs/run_x/answer.md", change: "create", bytes: 249, preview: "# RFC 9110: 502 Bad Gateway" }],
    digest: "f".repeat(64),
  };
  const decision = SalaamWorkDecision.parse({
    ...decisionFixture.decision,
    request_id: crypto.randomUUID(),
    work_request_id: work!.requestId,
    binding_digest: workDigest(payload.admission.binding),
    task_id: "99999999-9999-4999-8999-999999999999",
    expires_at: Date.now() + 60000,
    detail,
  });
  const offers: { parameter?: { detail?: unknown; options?: unknown } }[] = [];
  const client = {
    activity: async (_lease: unknown, activity: unknown) => {
      offers.push(activity as never);
      return {
        accepted: true as const,
        cardState: "input-required" as const,
        elicitationId: "elc_detail1",
        strictDecision: { version: 1 as const, request_id: decision.request_id, decision_digest: workDigest(decision), expires_at: decision.expires_at },
      };
    },
  };
  await publishSalaamDecision(session, user, decision, client);
  expect(offers[0]?.parameter?.detail).toEqual(detail);
  expect(offers[0]?.parameter?.options).toEqual(decision.options.map((v) => ({ name: v.id, title: v.title })));
});

// A strict run whose Salaam work stopped and whose session ended (run_84d49db766224895: a provider
// 429 failed its only step) was re-driven every 30s with "Session not found or not active". It is
// parked like the revoked case: once, surfaced once, and the roster claims again.
describe("a strict run whose session is gone is parked, not re-driven", () => {
  function depsWith(activities: unknown[], held: "live" | "waiting" | "gone") {
    return {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
      agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
      acp: { ensureStrictSession: async () => held, renewExecution: async () => { throw Error("Session not found or not active."); } },
      client: {
        context: async () => context,
        heartbeat: async () => ({}),
        activity: async (_lease: unknown, a: unknown) => {
          activities.push(a);
          return { accepted: true };
        },
      },
    } as unknown as DispatchDeps;
  }
  const dispatchRow = async () =>
    (await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, run)))[0]!;
  test("gone with no report intent: parked once, surfaced once, then no longer resumed", async () => {
    await reportFixture();
    const activities: unknown[] = [];
    const deps = depsWith(activities, "gone");
    try {
      const first = await resumeSalaamWork(deps);
      expect(first).toMatchObject({ status: "failed" });
      expect(String(first?.reason)).toContain("session ended");
      expect((await dispatchRow()).outcome).toBe("parked");
      expect(activities).toHaveLength(1);
      expect(await resumeSalaamWork(deps)).toBeNull();
      expect(activities).toHaveLength(1);
    } finally {
      await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
    }
  });
  test("gone with a saved report intent is not parked: the report path keeps it", async () => {
    const { work, completion } = await reportFixture();
    await db.insert(salaamWorkReports).values({
      workRequestId: work.requestId,
      tenantId,
      requestId: crypto.randomUUID(),
      completion,
      handoff: { historical: true },
      handoffDigest: "a".repeat(64),
      state: "prepared",
    });
    try {
      await resumeSalaamWork(depsWith([], "gone")).catch(() => null);
      expect((await dispatchRow()).outcome).not.toBe("parked");
    } finally {
      await db.delete(salaamWorkReports).where(eq(salaamWorkReports.workRequestId, work.requestId));
      await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
    }
  });
});

// Card 9 (card_81a3e7a5f62b4564): a run the task runtime limit stopped ended its session and was
// parked for an operator, so the card sat on "needs you" with no run. A stopped run whose effects
// Salaam can prove is settled automatically, as an expired approval already is; only a run Salaam
// cannot prove is still parked for review.
describe("a stopped strict run is settled automatically when Salaam proves its effects", () => {
  // A revoked, stopped session: everything the settlement itself checks holds, so only the status
  // proof stands between this run and a failed board run.
  async function revokeStopped() {
    const [original] = await db.select().from(acpSessions).where(eq(acpSessions.id, session));
    const authority = structuredClone(original!.executionAuthority!);
    authority.state = "revoked";
    (authority as any).receipt = {
      admission_id: authority.admissionId,
      session_id: authority.sessionId,
      binding: authority.binding,
      binding_digest: workDigest(authority.binding),
      lease_sequence: 1,
      expires_at: 0,
      authorized: false,
      revoked: true,
      owned_execution_stopped: true,
      unresolved_operations: [],
      active_attempts: [],
      interrupted_attempts: [],
    };
    await db.update(acpSessions).set({ status: "ended", executionAuthority: authority }).where(eq(acpSessions.id, session));
    return () =>
      db
        .update(acpSessions)
        .set({ status: original!.status, executionAuthority: original!.executionAuthority })
        .where(eq(acpSessions.id, session));
  }
  test("without Salaam's proof nothing changes: no settlement is started and the board run is not failed", async () => {
    await reportFixture();
    const restore = await revokeStopped();
    const failed: unknown[] = [];
    const verbs: string[] = [];
    const mock = spyOn(broker, "request").mockImplementation(async (_n, verb) => {
      verbs.push(String(verb));
      // A status without settlement_ready: Salaam cannot prove this run.
      return { ok: true, data: { version: 1, state: "blocked", auto_enabled: false } } as never;
    });
    const deps = {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
      agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
      acp: { ensureStrictSession: async () => "gone", renewExecution: async () => {} },
      client: {
        context: async () => context,
        heartbeat: async () => ({}),
        fail: async (...a: unknown[]) => void failed.push(a),
        activity: async () => ({ accepted: true }),
      },
    } as unknown as DispatchDeps;
    try {
      await resumeSalaamWork(deps);
      expect(verbs).toContain("salaam.work-status");
      expect(verbs).not.toContain("salaam.work-fail");
      expect(failed).toHaveLength(0);
      const [owner] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.sessionId, session));
      expect(owner?.settlement).toBeNull();
      expect((await dispatchRow()).outcome).toBe("parked");
    } finally {
      mock.mockRestore();
      await restore();
      await reset();
    }
  });
  test("the settlement is refused at the proof, before anything else is asked or changed", async () => {
    await reportFixture();
    const verbs: string[] = [];
    const mock = spyOn(broker, "request").mockImplementation(async (_n, verb) => {
      verbs.push(String(verb));
      return { ok: true, data: { version: 1, state: "blocked", auto_enabled: false } } as never;
    });
    try {
      const refused = await settleStoppedSalaamWork(
        { tenantId, source: "superpipeline", agent: { key: "proof", boardId: board, stationId: station, hubUserId: user } } as unknown as DispatchDeps,
        run,
      ).then(() => "settled", (e) => String(e));
      expect(refused).toContain("cannot prove");
      expect(verbs).toEqual(["salaam.work-status"]);
    } finally {
      mock.mockRestore();
    }
  });
  test("a refused settlement says which Salaam guard refused it", async () => {
    await reportFixture();
    const mock = spyOn(broker, "request").mockImplementation(async () => ({
      ok: true,
      data: {
        version: 1,
        state: "blocked",
        auto_enabled: false,
        settlement_refused: "work_settlement_unsafe: Revoked stopped root with known effects required",
      },
    }) as never);
    try {
      const refused = await settleStoppedSalaamWork(
        { tenantId, source: "superpipeline", agent: { key: "proof", boardId: board, stationId: station, hubUserId: user } } as unknown as DispatchDeps,
        run,
      ).then(() => "settled", (e) => String(e));
      expect(refused).toContain("cannot prove");
      expect(refused).toContain("work_settlement_unsafe: Revoked stopped root");
    } finally {
      mock.mockRestore();
    }
  });
  test("a settlement whose status could not be read says why", async () => {
    await reportFixture();
    const mock = spyOn(broker, "request").mockImplementation(async () => ({ ok: false, error: "salaam: private work owner mismatch" }) as never);
    try {
      const refused = await settleStoppedSalaamWork(
        { tenantId, source: "superpipeline", agent: { key: "proof", boardId: board, stationId: station, hubUserId: user } } as unknown as DispatchDeps,
        run,
      ).then(() => "settled", (e) => String(e));
      expect(refused).toContain("cannot prove");
      expect(refused).toContain("status unreadable: salaam: private work owner mismatch");
    } finally {
      mock.mockRestore();
    }
  });
  test("a status that does not match this run's owner names the field that differs", async () => {
    await reportFixture();
    const mock = spyOn(broker, "request").mockImplementation(async () => ({
      ok: true,
      data: { version: 1, state: "blocked", work_request_id: "someone-else", settlement_ready: "known_effects_failure" },
    }) as never);
    try {
      const refused = await settleStoppedSalaamWork(
        { tenantId, source: "superpipeline", agent: { key: "proof", boardId: board, stationId: station, hubUserId: user } } as unknown as DispatchDeps,
        run,
      ).then(() => "settled", (e) => String(e));
      expect(refused).toContain("cannot prove");
      expect(refused).toContain("status does not match: work_request_id");
      expect(refused).not.toContain("settlement_ready,");
    } finally {
      mock.mockRestore();
    }
  });
  test("a long refusal is never dropped: it is kept, cut with a marker", async () => {
    await reportFixture();
    const long = "work_settlement_unsafe: " + "x".repeat(2000);
    const mock = spyOn(broker, "request").mockImplementation(async () => ({
      ok: true,
      data: { version: 1, state: "blocked", auto_enabled: false, settlement_refused: long },
    }) as never);
    try {
      const refused = await settleStoppedSalaamWork(
        { tenantId, source: "superpipeline", agent: { key: "proof", boardId: board, stationId: station, hubUserId: user } } as unknown as DispatchDeps,
        run,
      ).then(() => "settled", (e) => String(e));
      expect(refused).toContain("(work_settlement_unsafe: xxx");
      expect(refused).toContain("… [cut]");
      expect(refused).not.toContain("status does not match");
      expect(refused.length).toBeLessThan(1200);
    } finally {
      mock.mockRestore();
    }
  });
  // Staging run_60cd40e7: the expiry settled before the session's stop receipt landed, so it was
  // refused ("Exact stopped work owner required") and the run parked. The re-offer must settle it
  // through the expiry protocol, not only the known-effects one.
  test("a parked run with an expired unanswered approval settles through the expiry protocol", async () => {
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
    const question = {
      id: "elc_parkedexpiry",
      runId: run,
      cardId: card,
      stageKey: "build",
      question: decision.question,
      signal: "select",
      options: decision.options.map((v) => ({ name: v.id, title: v.title })),
      strictDecision: {
        version: 1 as const,
        request_id: decision.request_id,
        decision_digest: workDigest(decision),
        expires_at: decision.expires_at,
      },
      status: "pending" as const,
      answer: null,
      createdAt: new Date().toISOString(),
    };
    let live = { ...context, elicitations: [question] };
    const client = {
      activity: async () => ({ accepted: true }),
      context: async () => live,
      // The board ends the run as the producer's non-success, as SuperPipeline does on fail.
      fail: async () => {
        live = {
          ...live,
          run: { ...live.run, status: "ended", outcome: "crashed", endedAt: new Date().toISOString() },
        };
        return {};
      },
      heartbeat: async () => ({}),
    };
    await publishSalaamDecision(session, user, decision, client);
    const restore = await revokeStopped();
    // The daemon's own admission and session ids (uuids), as a real stop receipt carries them.
    const [ended] = await db.select().from(acpSessions).where(eq(acpSessions.id, session));
    const authority = structuredClone(ended!.executionAuthority!);
    authority.sessionId = crypto.randomUUID();
    authority.admissionId = crypto.randomUUID();
    (authority as any).receipt = {
      ...(authority as any).receipt,
      session_id: authority.sessionId,
      admission_id: authority.admissionId,
    };
    await db.update(acpSessions).set({ executionAuthority: authority }).where(eq(acpSessions.id, session));
    const verbs: string[] = [];
    const mock = spyOn(broker, "request").mockImplementation(async (_n, verb, body: any) => {
      verbs.push(String(verb));
      if (verb !== "salaam.work-expire")
        return { ok: true, data: { version: 1, state: "cancelled", work_request_id: work.requestId } } as never;
      const [s] = await db.select().from(acpSessions).where(eq(acpSessions.id, session));
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
          session_id: s!.executionAuthority!.sessionId,
          task_id: completion.task_id,
          plan_revision: 1,
          binding_digest: workDigest(s!.executionAuthority!.binding),
          producer_terminal_digest: body.producer_terminal_digest,
        },
      } as never;
    });
    try {
      await settleStoppedSalaamWork(
        {
          tenantId,
          source: "superpipeline",
          salaamPublish: async () => publication,
          agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
          client,
        } as unknown as DispatchDeps,
        run,
      );
      expect(verbs).toContain("salaam.work-expire");
      const [saved] = await db
        .select()
        .from(salaamWorkDecisions)
        .where(eq(salaamWorkDecisions.requestId, decision.request_id));
      expect(saved?.answer).toBeNull();
    } finally {
      mock.mockRestore();
      await restore();
      await db.delete(salaamWorkDecisions).where(eq(salaamWorkDecisions.requestId, decision.request_id));
    }
  });
  test("a run whose settlement an operator already started is left to that settlement", async () => {
    await reportFixture();
    const [owner] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.sessionId, session));
    const verbs: string[] = [];
    const mock = spyOn(broker, "request").mockImplementation(async (_n, verb) => {
      verbs.push(String(verb));
      return { ok: false, error: "fixture" } as never;
    });
    await db
      .update(salaamWorkOwners)
      .set({ settlement: { version: 1, request_id: crypto.randomUUID(), terminal: null, receipt: null } })
      .where(eq(salaamWorkOwners.requestId, owner!.requestId));
    try {
      await settleStoppedSalaamWork({ tenantId, source: "superpipeline" } as unknown as DispatchDeps, run).catch(
        (e) => expect(String(e)).toContain("already in progress"),
      );
      expect(verbs).toEqual([]);
    } finally {
      mock.mockRestore();
      await db.update(salaamWorkOwners).set({ settlement: null }).where(eq(salaamWorkOwners.requestId, owner!.requestId));
    }
  });

  const dispatchRow = async () =>
    (await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, run)))[0]!;
  function depsWith(activities: unknown[], settle: (runId: string) => Promise<void>) {
    return {
      tenantId,
      source: "superpipeline",
      salaamPublish: async () => publication,
      agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
      acp: { ensureStrictSession: async () => "gone", renewExecution: async () => {} },
      settleStoppedWork: settle,
      client: {
        context: async () => context,
        heartbeat: async () => ({}),
        activity: async (_lease: unknown, a: unknown) => {
          activities.push(a);
          return { accepted: true };
        },
      },
    } as unknown as DispatchDeps;
  }
  const reset = () =>
    db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));

  test("proven: settled, not parked, and the card says the run was retired", async () => {
    await reportFixture();
    const activities: unknown[] = [];
    const settled: string[] = [];
    try {
      const result = await resumeSalaamWork(depsWith(activities, async (id) => void settled.push(id)));
      expect(settled).toEqual([run]);
      expect(result).toMatchObject({ status: "failed" });
      expect(String(result?.reason)).toContain("settled");
      expect((await dispatchRow()).outcome).not.toBe("parked");
      expect(JSON.stringify(activities)).toContain("retired");
      expect(JSON.stringify(activities)).not.toContain("operator review");
    } finally {
      await reset();
    }
  });

  test("not proven: parked for review exactly as before", async () => {
    await reportFixture();
    const activities: unknown[] = [];
    try {
      const result = await resumeSalaamWork(
        depsWith(activities, async () => {
          throw Error("Terminal settlement refused");
        }),
      );
      expect(String(result?.reason)).toContain("session ended");
      expect((await dispatchRow()).outcome).toBe("parked");
      expect(JSON.stringify(activities)).toContain("operator review");
    } finally {
      await reset();
    }
  });

  test("a run parked earlier is offered the settlement once, and then left alone", async () => {
    await reportFixture();
    await db
      .update(bridgeDispatches)
      .set({ outcome: "parked", updatedAt: new Date(), reason: "Strict session ended before report intent; explicit original-run reconciliation required" })
      .where(eq(bridgeDispatches.externalRunId, run));
    const activities: unknown[] = [];
    const settled: string[] = [];
    const deps = depsWith(activities, async (id) => void settled.push(id));
    try {
      await resumeSalaamWork(deps);
      await resumeSalaamWork(deps);
      expect(settled).toEqual([run]);
      expect(JSON.stringify(activities)).toContain("retired");
    } finally {
      await reset();
    }
  });
});

// A parked run whose proof was missing when it was first offered (Salaam not yet rolled out) is
// offered again after the retry interval, until it settles; then it is left alone.
test("a parked run is offered the settlement again later, and left alone once settled", async () => {
  await reportFixture();
  await db
    .update(bridgeDispatches)
    .set({ outcome: "parked", updatedAt: new Date(), reason: "Strict session ended before report intent; explicit original-run reconciliation required" })
    .where(eq(bridgeDispatches.externalRunId, run));
  let tries = 0;
  const deps = {
    tenantId,
    source: "superpipeline",
    salaamPublish: async () => publication,
    agent: { key: "proof", boardId: board, stationId: station, hubUserId: user },
    acp: { ensureStrictSession: async () => "gone", renewExecution: async () => {} },
    settlementRetryMs: 0,
    settleStoppedWork: async () => {
      if (++tries === 1) throw Error("Salaam cannot prove this stopped run's effects");
    },
    client: { context: async () => context, heartbeat: async () => ({}), activity: async () => ({ accepted: true }) },
  } as unknown as DispatchDeps;
  try {
    await resumeSalaamWork(deps);
    await resumeSalaamWork(deps);
    await resumeSalaamWork(deps);
    expect(tries).toBe(2);
  } finally {
    await db.update(bridgeDispatches).set({ outcome: "working", reason: null }).where(eq(bridgeDispatches.externalRunId, run));
  }
});
