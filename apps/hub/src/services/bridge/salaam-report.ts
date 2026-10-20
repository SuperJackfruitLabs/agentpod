/** Original-run report recovery: no new claim or cross-run replay can substitute
 * for a fresh protected completion and a matching original board receipt. */
import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import {
  salaamWorkOwners,
  salaamWorkReports,
} from "../../db/schema/salaam-work";
import {
  SalaamWorkPayload,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/salaam-work-payload";
import { SalaamWorkCompletion } from "../../../../../packages/contract/src/salaam-work-completion";
import { workDigest } from "../salaam-work";
import { validateSalaamAuthority } from "../salaam-authority";
import * as broker from "../broker";
import type { SuperpipelineClient, RunContext } from "./superpipeline";
const same = (a: unknown, b: unknown) =>
  canonicalSalaamWork(a) === canonicalSalaamWork(b);
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
    throw Error("Strict report owner unavailable");
  const payload = SalaamWorkPayload.parse(work.payload),
    execution = session.executionAuthority;
  if (!same(payload.admission.binding, execution.binding))
    throw Error("Strict report owner changed");
  return { session, work, payload, execution };
}
function checkCompletion(o: Awaited<ReturnType<typeof owner>>, value: unknown) {
  const completion = SalaamWorkCompletion.parse(value),
    admission = o.work.receipt as {
      task_id?: unknown;
      plan_revision?: unknown;
    };
  if (
    completion.work_request_id !== o.work.requestId ||
    completion.task_id !== admission.task_id ||
    completion.plan_revision !== admission.plan_revision ||
    completion.binding_digest !== workDigest(o.execution.binding)
  )
    throw Error("Completion names another admitted owner");
  return completion;
}
function checkRun(o: Awaited<ReturnType<typeof owner>>, context: RunContext) {
  const run = context.run,
    binding = o.execution.binding;
  if (
    run.runId !== binding.run.id ||
    run.leaseEpoch !== binding.run.epoch ||
    run.cardId !== o.payload.admission.work.card_id ||
    run.stageKey !== o.payload.admission.work.stage_key
  )
    throw Error("Original work run binding changed");
  if (!Object.hasOwn(run, "handoff") || !Object.hasOwn(run, "completion"))
    throw Error("Producer lacks original-run recovery evidence");
  return run;
}
async function freshCompletion(sessionId: string, userId: string) {
  const o = await owner(sessionId, userId);
  if (o.execution.state !== "active" || o.session.status === "ended")
    throw Error("Strict report execution revoked");
  await validateSalaamAuthority(o.execution.binding, userId);
  const response = await broker.request(
    o.execution.binding.node_id,
    "salaam.work-completion",
    { binding: o.execution.binding },
    { timeoutMs: 125_000 },
  );
  if (!response.ok) throw Error("Fresh protected completion unavailable");
  const current = await owner(sessionId, userId);
  if (
    current.execution.state !== "active" ||
    current.session.status === "ended"
  )
    throw Error("Strict report execution revoked during verification");
  await validateSalaamAuthority(current.execution.binding, userId);
  return checkCompletion(current, response.data);
}
function checkIntent(
  o: Awaited<ReturnType<typeof owner>>,
  intent: typeof salaamWorkReports.$inferSelect,
) {
  const completion = checkCompletion(o, intent.completion);
  const expected = {
    version: 1,
    source: "salaam",
    report_request_id: intent.requestId,
    completion,
  };
  if (
    !same(intent.handoff, expected) ||
    workDigest(expected) !== intent.handoffDigest
  )
    throw Error("Saved report digest or handoff mismatch");
}
async function acknowledge(
  o: Awaited<ReturnType<typeof owner>>,
  intent: typeof salaamWorkReports.$inferSelect,
  context: RunContext,
) {
  const run = checkRun(o, context),
    verdict = run.completion as { met?: unknown; outcome?: unknown } | null;
  if (
    run.status !== "ended" ||
    run.outcome !== "completed" ||
    verdict?.met !== true ||
    verdict.outcome !== "pass" ||
    !same(run.handoff, intent.handoff) ||
    workDigest(intent.handoff) !== intent.handoffDigest
  )
    throw Error("Original run completion conflicts with saved report intent");
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(salaamWorkReports)
      .where(eq(salaamWorkReports.workRequestId, o.work.requestId))
      .for("update");
    if (
      !current ||
      !same(current.completion, intent.completion) ||
      !same(current.handoff, intent.handoff)
    )
      throw Error("Strict report intent changed");
    await tx
      .update(salaamWorkReports)
      .set({ state: "reported", boardReceipt: run })
      .where(eq(salaamWorkReports.workRequestId, o.work.requestId));
    await tx
      .update(bridgeDispatches)
      .set({
        outcome: "reported",
        result: intent.handoff,
        reason: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(bridgeDispatches.tenantId, o.work.tenantId),
          eq(bridgeDispatches.externalSource, o.work.externalSource),
          eq(bridgeDispatches.externalRunId, o.work.externalRunId),
          eq(bridgeDispatches.leaseEpoch, o.execution.binding.run.epoch),
        ),
      );
  });
  return {
    state: "reported" as const,
    request_id: intent.requestId,
    run_id: o.execution.binding.run.id,
    handoff_digest: intent.handoffDigest,
  };
}
/** Every lost complete reply reconciles the ORIGINAL run before any resend.
 * Positive HTTP responses are not enough: read back the stored pass and handoff. */
export async function reportSalaamCompletion(
  sessionId: string,
  userId: string,
  client: Pick<SuperpipelineClient, "context" | "completeVerified">,
) {
  const o = await owner(sessionId, userId);
  let [intent] = await db
    .select()
    .from(salaamWorkReports)
    .where(eq(salaamWorkReports.workRequestId, o.work.requestId));
  if (intent) checkIntent(o, intent);
  let context = await client.context(o.execution.binding.run.id),
    run = checkRun(o, context);
  if (intent && run.status === "ended") return acknowledge(o, intent, context);
  if (run.status !== "working")
    throw Error("Original run is not live; do not claim a replacement");
  if (intent?.state === "reported")
    throw Error("Reported original run changed unexpectedly");
  if (!intent) {
    const completion = await freshCompletion(sessionId, userId);
    const requestId = crypto.randomUUID(),
      handoff = {
        version: 1,
        source: "salaam",
        report_request_id: requestId,
        completion,
      };
    intent = await db.transaction(async (tx) => {
      await tx
        .select()
        .from(salaamWorkOwners)
        .where(eq(salaamWorkOwners.requestId, o.work.requestId))
        .for("update");
      await tx
        .insert(salaamWorkReports)
        .values({
          workRequestId: o.work.requestId,
          requestId,
          completion,
          handoff,
          handoffDigest: workDigest(handoff),
          state: "prepared",
        })
        .onConflictDoNothing();
      const [saved] = await tx
        .select()
        .from(salaamWorkReports)
        .where(eq(salaamWorkReports.workRequestId, o.work.requestId));
      if (!saved || !same(saved.completion, completion))
        throw Error("Completion changed while report intent was reserved");
      return saved;
    });
  }
  checkIntent(o, intent);
  // May have completed through another controller while intent was being read.
  context = await client.context(o.execution.binding.run.id);
  run = checkRun(o, context);
  if (run.status === "ended") return acknowledge(o, intent, context);
  if (run.status !== "working") throw Error("Original run is not live");
  const completion = await freshCompletion(sessionId, userId);
  if (!same(completion, intent.completion))
    throw Error("Protected completion changed; old intent cannot be reported");
  // Any lost response leaves the immutable intent prepared. Recovery reads this
  // same run, even if its lease has subsequently expired or its card has moved.
  await client.completeVerified(
    {
      runId: o.execution.binding.run.id,
      leaseEpoch: o.execution.binding.run.epoch,
    },
    intent.handoff,
  );
  return acknowledge(
    o,
    intent,
    await client.context(o.execution.binding.run.id),
  );
}
