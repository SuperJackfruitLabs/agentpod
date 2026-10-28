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
  SuperpipelineStrictDecision,
} from "../../../../../packages/contract/src/salaam-work-decision";
import {
  SalaamWorkPayload,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/salaam-work-payload";
import { workDigest } from "../salaam-work";
import { stations } from "../../db/schema/stations";
import { AlwaysAllowRefused, alwaysAllowFromAnswer } from "../agent-approval-rules";
import { renewSalaamExecution, validateSalaamAuthority } from "../salaam-authority";
import * as broker from "../broker";
import type { SuperpipelineClient } from "./superpipeline";
const strictSchema = SuperpipelineStrictDecision;
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
      decision: z.enum(["approve", "approve-run", "always", "deny"]),
      // "Approve for this run": the grant Salaam recorded with the decision.
      grant_id: z.string().uuid().optional(),
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
/** The board's options. "Always allow" names the station's agent when the hub knows it, Salaam's
 * own words otherwise; the same function builds every comparison, so the binding stays exact. */
async function boardOptions(o: Awaited<ReturnType<typeof owner>>, decision: SalaamWorkDecision) {
  let name: string | null = null;
  if (decision.options.some((v) => v.id === "always")) {
    const [s] = await db
      .select({ displayName: stations.displayName })
      .from(stations)
      .where(eq(stations.id, o.execution.binding.station_id));
    name = s?.displayName?.trim() || null;
  }
  return decision.options.map((v) =>
    v.id === "always"
      ? {
          name: v.id,
          title: name ? `Always allow ${name} to write in its workspace` : v.title,
          requires: v.requires,
        }
      : { name: v.id, title: v.title },
  );
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
  client: Pick<SuperpipelineClient, "activity"> &
    Partial<Pick<SuperpipelineClient, "context">>,
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
        tenantId: o.work.tenantId,
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
  let receipt: z.infer<typeof producerSchema>;
  if (Date.now() >= decision.expires_at) {
    // Historical correlation is read-only. Never re-post an expired offer or
    // treat a recovered producer question as an approval.
    if (!client.context)
      throw Error("expired strict question requires original run read");
    const context = await client.context(o.execution.binding.run.id);
    if (
      context.run.runId !== o.execution.binding.run.id ||
      context.run.leaseEpoch !== o.execution.binding.run.epoch ||
      context.run.cardId !== o.payload.admission.work.card_id ||
      context.run.stageKey !== o.payload.admission.work.stage_key
    )
      throw Error("Expired strict question original run changed");
    const questions = (context.elicitations ?? []).filter((q) =>
      same(q.strictDecision ?? null, correlation(decision)),
    );
    const question = questions[0];
    if (
      questions.length !== 1 ||
      !question ||
      question.runId !== context.run.runId ||
      question.cardId !== context.run.cardId ||
      question.stageKey !== context.run.stageKey ||
      question.question !== decision.question ||
      question.signal !== "select" ||
      !same(
        question.options,
        await boardOptions(o, decision),
      )
    )
      throw Error("Expired strict question historical binding mismatch");
    receipt = producerSchema.parse({
      accepted: true,
      cardState: "input-required",
      elicitationId: question.id,
      strictDecision: question.strictDecision,
    });
  } else {
    await fresh(await owner(sessionId, userId), decision);
    receipt = producerSchema.parse(
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
            options: await boardOptions(o, decision),
            // Readable approvals: the producer shows what is being approved from these fields.
            ...(decision.detail ? { detail: decision.detail } : {}),
          },
          strictDecision: correlation(decision),
        },
      ),
    );
  }
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
/** Refusals of "Always allow" already told on the card (request id + message), so each is told once. */
const toldRefusals = new Set<string>();

export async function answerSalaamDecision(
  sessionId: string,
  userId: string,
  requestId: string,
  client: Pick<SuperpipelineClient, "context"> & Partial<Pick<SuperpipelineClient, "activity">>,
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
        await boardOptions(o, decision),
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
  // "Always allow": the hub's guard sets the standing rule first; any refusal stops the answer here.
  // The board names the answerer by its own user id; the org plane knows only principals, so the
  // board's mapping is read fresh for this very answer, and role is still read from the plane.
  if (answer.option_id === "always")
    try {
      const context = await client.context(o.execution.binding.run.id);
      const said = context.elicitations?.find((v) => v.id === producer.elicitationId)?.answer;
      const principal =
        said && said.option === "always" && said.answeredBy === answer.answered_by
          ? (said.answeredByPrincipal ?? null)
          : null;
      if (!principal)
        throw new AlwaysAllowRefused("Always allow could not check who answered; nothing was approved.");
      await alwaysAllowFromAnswer({
        tenantId: o.work.tenantId,
        stationId: o.execution.binding.station_id,
        answeredBy: principal,
      });
    } catch (error) {
      if (!(error instanceof AlwaysAllowRefused)) throw error;
      return await tellRefusal(error);
    }
  if (answer.option_id === "always")
    // The run holds the rule before its next write: renewal restates the live rules to Salaam now,
    // instead of at the next scheduled renewal (the person said "always"; they are not asked again).
    // Revocation still reaches the run at renewal, as before. If this early renewal fails, the rule is
    // still set and this write is still approved; the run learns the rule at its scheduled renewal.
    try {
      await renewSalaamExecution(sessionId, userId);
    } catch {
      /* best effort: the scheduled renewal restates the rule */
    }
  async function tellRefusal(error: AlwaysAllowRefused) {
      // Told once on the card, in plain words; the approval stays open until it expires and is
      // offered again. Nothing is forwarded, and the run carries on waiting.
      const key = requestId + "\n" + error.message;
      if (!toldRefusals.has(key)) {
        toldRefusals.add(key);
        try {
          await client.activity?.(
            { runId: o.execution.binding.run.id, leaseEpoch: o.execution.binding.run.epoch },
            { type: "thought", body: error.message },
          );
        } catch {
          /* the note is best effort; nothing was approved either way */
        }
      }
      return { state: "pending" as const };
    }
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
