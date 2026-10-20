/** Private bridge control, never an HTTP/model door. Reservation precedes delivery;
 * missing replies retain the same owner and request, not another task or run. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import { salaamWorkOwners } from "../../db/schema/salaam-work";
import { prepareSalaamWork, workDigest } from "../salaam-work";
import {
  SalaamWorkPayload,
  canonicalSalaamWork,
} from "../../../../../packages/contract/src/salaam-work-payload";
import { validateSalaamAuthority } from "../salaam-authority";
import * as broker from "../broker";
import type { ClaimedWork, RunContext } from "./superpipeline";

const receiptSchema = z
  .object({
    version: z.literal(1),
    state: z.literal("admitted"),
    session_id: z.string().min(1),
    task_id: z.string().min(1),
    request_id: z.string().uuid(),
    binding_digest: z.string().regex(/^[a-f0-9]{64}$/),
    plan_revision: z.literal(1),
  })
  .strict();
const ownerScope = (run: string) =>
  and(
    eq(salaamWorkOwners.externalSource, "superpipeline"),
    eq(salaamWorkOwners.externalRunId, run),
  );

/** The caller supplies the actual claim/context read from Superpipeline. All
 * identity fields are compared to the persisted session and dispatch owner. */
export async function reserveSalaamWork(
  sessionId: string,
  userId: string,
  claim: ClaimedWork,
  context: RunContext,
  plan: unknown,
) {
  if (
    context.run.runId !== claim.runId ||
    context.run.leaseEpoch !== claim.leaseEpoch ||
    context.run.cardId !== claim.card.id ||
    context.card.id !== claim.card.id ||
    context.run.stageKey !== claim.stage?.key ||
    context.stage?.key !== claim.stage?.key
  )
    throw Error("Salaam work context differs from its claim");
  const input = {
    instructions: JSON.stringify({
      card: context.card,
      stage: context.stage,
      comments: context.comments ?? [],
      commentsOmitted: context.commentsOmitted ?? 0,
    }),
    references: context.references.map((r) => canonicalSalaamWork(r)),
    incoming_handoff:
      context.handoff == null ? null : canonicalSalaamWork(context.handoff),
  };
  return db.transaction(async (tx) => {
    // Lock in dispatch/session order consistently with claim recovery.
    const [dispatch] = await tx
      .select()
      .from(bridgeDispatches)
      .where(
        and(
          eq(bridgeDispatches.externalSource, "superpipeline"),
          eq(bridgeDispatches.externalRunId, claim.runId),
        ),
      )
      .for("update");
    const [session] = await tx
      .select()
      .from(acpSessions)
      .where(eq(acpSessions.id, sessionId))
      .for("update");
    const execution = session?.executionAuthority;
    if (
      !dispatch ||
      !session ||
      session.userId !== userId ||
      !execution ||
      dispatch.tenantId !== session.tenantId ||
      dispatch.stationId !== session.stationId ||
      dispatch.externalCardId !== claim.card.id ||
      dispatch.leaseEpoch !== claim.leaseEpoch ||
      execution.binding.run.id !== claim.runId ||
      execution.binding.run.epoch !== claim.leaseEpoch
    )
      throw Error(
        "Salaam work owner does not match persisted dispatch/session",
      );
    const [saved] = await tx
      .select()
      .from(salaamWorkOwners)
      .where(ownerScope(claim.runId));
    const payload = prepareSalaamWork(
      saved?.requestId ?? crypto.randomUUID(),
      execution.binding,
      {
        board_id: dispatch.boardId,
        card_id: dispatch.externalCardId,
        stage_key: context.run.stageKey,
      },
      input,
      plan,
    );
    if (saved) {
      if (
        saved.tenantId !== session.tenantId ||
        saved.sessionId !== sessionId ||
        canonicalSalaamWork(SalaamWorkPayload.parse(saved.payload)) !==
          canonicalSalaamWork(payload)
      )
        throw Error(
          "Salaam original work input or owner changed; reconcile instead of replacing",
        );
      return saved;
    }
    if (
      execution.state !== "active" ||
      session.status === "ended" ||
      dispatch.outcome !== "working"
    )
      throw Error("Salaam work owner is not active");
    await validateSalaamAuthority(execution.binding, userId);
    const [created] = await tx
      .insert(salaamWorkOwners)
      .values({
        externalSource: "superpipeline",
        externalRunId: claim.runId,
        tenantId: session.tenantId,
        sessionId,
        requestId: payload.admission.request_id,
        payload,
      })
      .returning();
    return created!;
  });
}

/** Uses only durable payload, never caller-provided replacement bytes. Saved
 * admission receipts are read-scoped and are not completion/effect receipts. */
export async function deliverSalaamWork(sessionId: string, userId: string) {
  const [session] = await db
    .select()
    .from(acpSessions)
    .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)));
  const [saved] = await db
    .select()
    .from(salaamWorkOwners)
    .where(eq(salaamWorkOwners.sessionId, sessionId));
  if (
    !session ||
    !saved ||
    session.tenantId !== saved.tenantId ||
    !session.executionAuthority
  )
    throw Error("Salaam work owner is unavailable");
  const payload = SalaamWorkPayload.parse(saved.payload),
    execution = session.executionAuthority;
  if (
    canonicalSalaamWork(payload.admission.binding) !==
    canonicalSalaamWork(execution.binding)
  )
    throw Error("Salaam work execution changed");
  const checkReceipt = (value: unknown) => {
    const receipt = receiptSchema.parse(value);
    if (
      receipt.request_id !== saved.requestId ||
      receipt.session_id !== execution.sessionId ||
      receipt.binding_digest !== workDigest(payload.admission.binding)
    )
      throw Error("Salaam work receipt belongs to another owner");
    return receipt;
  };
  if (saved.receipt) return checkReceipt(saved.receipt);
  if (execution.state !== "active" || session.status === "ended")
    throw Error("Salaam execution is stopping");
  await validateSalaamAuthority(execution.binding, userId);
  const result = await broker.request(
    payload.admission.binding.node_id,
    "salaam.work-admit",
    payload,
  );
  if (!result.ok)
    throw Error(
      "Salaam work delivery unresolved; recover the original request",
    );
  const receipt = checkReceipt(result.data);
  // Admission acknowledgement alone never reports board completion or progresses.
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(salaamWorkOwners)
      .where(ownerScope(saved.externalRunId))
      .for("update");
    if (
      !current ||
      current.requestId !== saved.requestId ||
      canonicalSalaamWork(current.payload) !== canonicalSalaamWork(payload) ||
      (current.receipt &&
        canonicalSalaamWork(current.receipt) !== canonicalSalaamWork(receipt))
    )
      throw Error("Salaam durable work receipt conflict");
    await tx
      .update(salaamWorkOwners)
      .set({ receipt })
      .where(ownerScope(saved.externalRunId));
  });
  return receipt;
}
