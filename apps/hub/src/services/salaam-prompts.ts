/** Durable consumer identity; transport numbers never name a logical instruction. */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { SalaamPromptReceipt } from "@agentpod/contract";
import { z } from "zod";
import { db } from "../db/drizzle";
import { acpSessions, acpPromptRequests } from "../db/schema/acp";
const uuid = z
  .string()
  .uuid()
  .transform((x) => x.toLowerCase());
type State = SalaamPromptReceipt["state"];
const receipt = (row: typeof acpPromptRequests.$inferSelect) =>
  SalaamPromptReceipt.parse(row);
export async function bindSalaamPrompt(
  userId: string,
  sessionId: string,
  requestId: string,
  text: string,
) {
  requestId = uuid.parse(requestId);
  const inputDigest = createHash("sha256")
    .update(JSON.stringify({ text }))
    .digest("hex");
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(acpSessions)
      .where(and(eq(acpSessions.id, sessionId), eq(acpSessions.userId, userId)))
      .for("update");
    if (!session?.executionAuthority) throw Error("Salaam session not found");
    const [old] = await tx
      .select()
      .from(acpPromptRequests)
      .where(
        and(
          eq(acpPromptRequests.sessionId, sessionId),
          eq(acpPromptRequests.requestId, requestId),
        ),
      );
    if (old) {
      if (old.inputDigest !== inputDigest)
        throw Error("Logical prompt ID already binds different input");
      return { fresh: false, receipt: receipt(old) };
    }
    if (
      session.status === "ended" ||
      session.executionAuthority.state !== "active"
    )
      throw Error("Salaam session has ended");
    if (session.status !== "idle")
      throw Error("Session is busy — wait for the current turn to finish.");
    const [pending] = await tx
      .select()
      .from(acpPromptRequests)
      .where(
        and(
          eq(acpPromptRequests.sessionId, sessionId),
          inArray(acpPromptRequests.state, [
            "prepared",
            "dispatched",
            "accepted",
            "unknown",
          ]),
        ),
      );
    if (pending)
      throw Error(
        "An earlier Salaam instruction needs reconciliation before another prompt",
      );
    const [saved] = await tx
      .insert(acpPromptRequests)
      .values({
        sessionId,
        tenantId: session.tenantId,
        requestId,
        inputDigest,
        inputText: text,
        state: "prepared",
      })
      .returning();
    return { fresh: true, receipt: receipt(saved!) };
  });
}
export async function getSalaamPrompt(
  userId: string,
  sessionId: string,
  requestId: string,
) {
  requestId = uuid.parse(requestId);
  const [row] = await db
    .select({ prompt: acpPromptRequests })
    .from(acpPromptRequests)
    .innerJoin(acpSessions, eq(acpSessions.id, acpPromptRequests.sessionId))
    .where(
      and(
        eq(acpSessions.userId, userId),
        eq(acpPromptRequests.sessionId, sessionId),
        eq(acpPromptRequests.requestId, requestId),
      ),
    );
  if (!row) throw Error("Salaam prompt not found");
  return receipt(row.prompt);
}
export async function updateSalaamPrompt(
  sessionId: string,
  requestId: string,
  state: State,
  attemptId?: string,
) {
  requestId = uuid.parse(requestId);
  if (attemptId) attemptId = uuid.parse(attemptId);
  return db.transaction(async (tx) => {
    const [old] = await tx
      .select()
      .from(acpPromptRequests)
      .where(
        and(
          eq(acpPromptRequests.sessionId, sessionId),
          eq(acpPromptRequests.requestId, requestId),
        ),
      )
      .for("update");
    if (!old) throw Error("Salaam prompt not found");
    if (old.attemptId && attemptId && old.attemptId !== attemptId)
      throw Error("Logical prompt receipt changed its attempt");
    if (["completed", "interrupted"].includes(old.state)) {
      if (!old.attemptId && attemptId) {
        const [enriched] = await tx
          .update(acpPromptRequests)
          .set({ attemptId })
          .where(
            and(
              eq(acpPromptRequests.sessionId, sessionId),
              eq(acpPromptRequests.requestId, requestId),
            ),
          )
          .returning();
        return receipt(enriched!);
      }
      return receipt(old);
    }
    if (
      old.state === "accepted" &&
      ["prepared", "dispatched", "unknown"].includes(state)
    )
      return receipt(old);
    const [saved] = await tx
      .update(acpPromptRequests)
      .set({ state, attemptId: attemptId ?? old.attemptId })
      .where(
        and(
          eq(acpPromptRequests.sessionId, sessionId),
          eq(acpPromptRequests.requestId, requestId),
        ),
      )
      .returning();
    return receipt(saved!);
  });
}
