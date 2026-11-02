import { eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { salaamWorkDecisions, salaamWorkOwners } from "../../db/schema/salaam-work";
import type { DispatchDeps } from "./dispatch-types";
import { settleNeverDispatchedSalaamWork } from "./salaam-dispatch-settle";
import { publishSalaamDecision } from "./salaam-decisions";

/** Expiry is a terminal non-success recovery, never a substitute answer. */
export async function recoverExpiredSalaamDecision(
  deps: DispatchDeps,
  sessionId: string,
) {
  const [work] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  if (!work) return null;
  const decisions = await db
    .select()
    .from(salaamWorkDecisions)
    .where(eq(salaamWorkDecisions.workRequestId, work.requestId));
  const expired = decisions.filter(
    (d) =>
      !d.daemonReceipt &&
      Number((d.decision as { expires_at: number }).expires_at) <= Date.now(),
  );
  if (!expired.length) return null;
  if (expired.length !== 1 || expired[0]!.answer)
    throw Error("Expired decision recovery is ambiguous");
  const decision = expired[0]!;
  await publishSalaamDecision(
    sessionId,
    deps.agent.hubUserId,
    decision.decision,
    deps.client,
  );
  await deps.acp.endSession(
    deps.agent.hubUserId,
    sessionId,
    "Strict decision expired unanswered",
  );
  await settleNeverDispatchedSalaamWork(
    deps,
    work.externalRunId,
    decision.requestId,
    decision.requestId,
  );
  return {
    status: "failed" as const,
    externalRunId: work.externalRunId,
    reason:
      "Expired unanswered approval cancelled and original producer non-success verified",
  };
}
