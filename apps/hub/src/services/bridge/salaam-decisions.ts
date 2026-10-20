/** Strict decision correlation. Legacy ACP/latest-question logic never runs here. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import {
  salaamWorkOwners,
  salaamWorkDecisions,
} from "../../db/schema/salaam-work";
import {
  SalaamWorkDecision,
  SalaamWorkDecisionAnswer,
} from "../../../../../packages/contract/src/salaam-work-decision";
import {
  SalaamWorkPayload,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/salaam-work-payload";
import { workDigest } from "../salaam-work";
import { validateSalaamAuthority } from "../salaam-authority";
import * as broker from "../broker";
import type { SuperpipelineClient } from "./superpipeline";
const strictSchema = z
  .object({
    version: z.literal(1),
    request_id: z.string().uuid(),
    decision_digest: z.string().regex(/^[a-f0-9]{64}$/),
    expires_at: z.number().int().positive(),
  })
  .strict();
const producerSchema = z
  .object({
    accepted: z.literal(true),
    cardState: z.literal("input-required"),
    elicitationId: z.string().regex(/^elc_[A-Za-z0-9]{6,}$/),
    strictDecision: strictSchema,
  })
  .strict();
const same = (a: unknown, b: unknown) =>
  canonicalSalaamWork(a) === canonicalSalaamWork(b);
function checkedDaemonReceipt(
  value: unknown,
  answer: SalaamWorkDecisionAnswer,
) {
  const receipt = z
    .object({
      version: z.literal(1),
      request_id: z.string().uuid(),
      decision_digest: z.string(),
      approval_id: z.string().uuid(),
      decision: z.enum(["approve", "deny"]),
    })
    .strict()
    .parse(value);
  if (
    receipt.request_id !== answer.request_id ||
    receipt.decision_digest !== answer.decision_digest ||
    receipt.approval_id !== answer.decision.approval_id ||
    receipt.decision !== answer.option_id
  )
    throw Error("Strict daemon receipt mismatch");
  return receipt;
}
async function owner(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  if (
    !session?.executionAuthority ||
    !work ||
    work.tenantId !== session.tenantId ||
    !work.receipt
  )
    throw Error("Strict decision work owner unavailable");
  const payload = SalaamWorkPayload.parse(work.payload),
    execution = session.executionAuthority;
  if (!same(payload.admission.binding, execution.binding))
    throw Error("Strict decision owner changed");
  return { session, work, payload, execution };
}
async function fresh(
  o: Awaited<ReturnType<typeof owner>>,
  decision: SalaamWorkDecision,
) {
  if (
    o.execution.state !== "active" ||
    o.session.status === "ended" ||
    Date.now() >= decision.expires_at
  )
    throw Error("Strict decision expired or revoked");
  await validateSalaamAuthority(o.execution.binding, o.session.userId);
  if (Date.now() >= decision.expires_at) throw Error("Strict decision expired");
}
function bound(o: Awaited<ReturnType<typeof owner>>, value: unknown) {
  const decision = SalaamWorkDecision.parse(value),
    receipt = o.work.receipt as { task_id?: unknown; plan_revision?: unknown };
  if (
    decision.work_request_id !== o.work.requestId ||
    decision.binding_digest !== workDigest(o.execution.binding) ||
    decision.task_id !== receipt.task_id ||
    decision.plan_revision !== receipt.plan_revision
  )
    throw Error("Strict decision does not match admitted task/plan/root");
  return decision;
}
const correlation = (decision: SalaamWorkDecision) => ({
  version: 1 as const,
  request_id: decision.request_id,
  decision_digest: workDigest(decision),
  expires_at: decision.expires_at,
});
/** Decision comes from the private daemon discovery receipt, never ACP metadata.
 * Identity and immutable offer are reserved before posting to the board. */
export async function publishSalaamDecision(
  sessionId: string,
  userId: string,
  value: unknown,
  client: Pick<SuperpipelineClient, "activity">,
) {
  const o = await owner(sessionId, userId),
    decision = bound(o, value);
  const saved = await db.transaction(async (tx) => {
    await tx
      .select()
      .from(salaamWorkOwners)
      .where(eq(salaamWorkOwners.requestId, o.work.requestId))
      .for("update");
    await tx
      .insert(salaamWorkDecisions)
      .values({
        requestId: decision.request_id,
        workRequestId: o.work.requestId,
        decision,
      })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(salaamWorkDecisions)
      .where(eq(salaamWorkDecisions.requestId, decision.request_id))
      .for("update");
    if (
      !row ||
      row.workRequestId !== o.work.requestId ||
      !same(row.decision, decision)
    )
      throw Error("Strict decision request conflict");
    return row;
  });
  if (saved.producerReceipt) {
    const receipt = producerSchema.parse(saved.producerReceipt);
    if (!same(receipt.strictDecision, correlation(decision)))
      throw Error("Saved strict producer receipt mismatch");
    return receipt;
  }
  await fresh(await owner(sessionId, userId), decision);
  const receipt = producerSchema.parse(
    await client.activity(
      {
        runId: o.execution.binding.run.id,
        leaseEpoch: o.execution.binding.run.epoch,
      },
      {
        type: "elicitation",
        signal: "select",
        body: decision.question,
        parameter: {
          options: decision.options.map((v) => ({
            name: v.id,
            title: v.title,
          })),
        },
        strictDecision: correlation(decision),
      },
    ),
  );
  if (!same(receipt.strictDecision, correlation(decision)))
    throw Error("Producer did not bind the exact strict decision");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(salaamWorkDecisions)
      .where(eq(salaamWorkDecisions.requestId, decision.request_id))
      .for("update");
    if (
      !row ||
      !same(row.decision, decision) ||
      (row.producerReceipt && !same(row.producerReceipt, receipt))
    )
      throw Error("Producer question receipt conflict");
    await tx
      .update(salaamWorkDecisions)
      .set({ producerReceipt: receipt })
      .where(eq(salaamWorkDecisions.requestId, decision.request_id));
  });
  return receipt;
}
/** Resolve ONLY the producer-returned question ID. Reverse order, missing strict
 * fields, expired replies, and another operation's answer never select a grant. */
export async function answerSalaamDecision(
  sessionId: string,
  userId: string,
  requestId: string,
  client: Pick<SuperpipelineClient, "context">,
) {
  const o = await owner(sessionId, userId);
  const [saved] = await db
    .select()
    .from(salaamWorkDecisions)
    .where(
      and(
        eq(salaamWorkDecisions.requestId, requestId),
        eq(salaamWorkDecisions.workRequestId, o.work.requestId),
      ),
    );
  if (!saved?.producerReceipt)
    throw Error("Strict question has no exact producer receipt");
  const decision = bound(o, saved.decision),
    producer = producerSchema.parse(saved.producerReceipt);
  if (!same(producer.strictDecision, correlation(decision)))
    throw Error("Strict producer receipt changed");
  const readAnswer = (value: unknown) => {
    const answer = SalaamWorkDecisionAnswer.parse(value);
    if (
      !same(answer.decision, decision) ||
      answer.decision_digest !== workDigest(decision) ||
      answer.elicitation_id !== producer.elicitationId
    )
      throw Error("Saved strict answer binding mismatch");
    return answer;
  };
  if (saved.daemonReceipt)
    return checkedDaemonReceipt(saved.daemonReceipt, readAnswer(saved.answer));
  await fresh(await owner(sessionId, userId), decision);
  let answer: SalaamWorkDecisionAnswer;
  if (saved.answer) answer = readAnswer(saved.answer);
  else {
    const context = await client.context(o.execution.binding.run.id);
    const question = context.elicitations?.find(
      (v) => v.id === producer.elicitationId,
    );
    if (
      context.run.runId !== o.execution.binding.run.id ||
      context.run.leaseEpoch !== o.execution.binding.run.epoch ||
      context.run.cardId !== o.payload.admission.work.card_id ||
      context.run.stageKey !== o.payload.admission.work.stage_key ||
      !question ||
      question.runId !== context.run.runId ||
      question.cardId !== context.run.cardId ||
      question.stageKey !== context.run.stageKey ||
      !same(question.strictDecision ?? null, correlation(decision)) ||
      question.question !== decision.question ||
      !same(
        question.options,
        decision.options.map((v) => ({ name: v.id, title: v.title })),
      )
    )
      throw Error("Strict question binding differs from original offer");
    if (question.status === "cancelled")
      throw Error("Strict question cancelled");
    if (question.status !== "answered") return { state: "pending" };
    const response = question.answer;
    if (
      !response ||
      !decision.options.some((v) => v.id === response.option) ||
      !response.answeredBy ||
      response.answeredBy === o.execution.binding.principal_id ||
      !Number.isFinite(Date.parse(response.answeredAt)) ||
      Date.parse(response.answeredAt) >= decision.expires_at
    )
      throw Error("Strict answer is not an eligible exact choice");
    answer = SalaamWorkDecisionAnswer.parse({
      version: 1,
      request_id: crypto.randomUUID(),
      decision,
      decision_digest: workDigest(decision),
      elicitation_id: producer.elicitationId,
      option_id: response.option,
      answered_by: response.answeredBy,
      answered_at: response.answeredAt,
    });
    await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(salaamWorkDecisions)
        .where(eq(salaamWorkDecisions.requestId, requestId))
        .for("update");
      if (!row || !same(row.decision, decision))
        throw Error("Strict decision changed");
      if (row.answer) {
        const existing = SalaamWorkDecisionAnswer.parse(row.answer);
        if (!same({ ...existing, request_id: answer.request_id }, answer))
          throw Error("Strict answer conflict");
        answer = existing;
      } else
        await tx
          .update(salaamWorkDecisions)
          .set({ answer })
          .where(eq(salaamWorkDecisions.requestId, requestId));
    });
  }
  await fresh(await owner(sessionId, userId), decision);
  const result = await broker.request(
    o.execution.binding.node_id,
    "salaam.work-decision",
    { binding: o.execution.binding, answer },
  );
  if (!result.ok)
    throw Error("Strict answer delivery unresolved; retry original answer");
  const receipt = checkedDaemonReceipt(result.data, answer);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(salaamWorkDecisions)
      .where(eq(salaamWorkDecisions.requestId, requestId))
      .for("update");
    if (
      !row ||
      !same(row.answer, answer) ||
      (row.daemonReceipt && !same(row.daemonReceipt, receipt))
    )
      throw Error("Strict daemon answer conflict");
    await tx
      .update(salaamWorkDecisions)
      .set({ daemonReceipt: receipt })
      .where(eq(salaamWorkDecisions.requestId, requestId));
  });
  return receipt;
}

/** Only this private daemon observation can supply strict offers to the bridge. */
export async function discoverSalaamDecisions(
  sessionId: string,
  userId: string,
) {
  const o = await owner(sessionId, userId);
  if (o.execution.state !== "active" || o.session.status === "ended")
    throw Error("Strict decision execution revoked");
  await validateSalaamAuthority(o.execution.binding, userId);
  const result = await broker.request(
    o.execution.binding.node_id,
    "salaam.work-decisions",
    { binding: o.execution.binding },
  );
  if (!result.ok) throw Error("Strict decision discovery unavailable");
  const resultSchema = z
    .object({
      version: z.literal(1),
      decisions: z.array(SalaamWorkDecision).max(64),
    })
    .strict();
  const view = resultSchema.parse(result.data),
    current = await owner(sessionId, userId);
  for (const decision of view.decisions) {
    bound(current, decision);
    await fresh(current, decision);
  }
  return view;
}
