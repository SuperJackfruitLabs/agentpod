import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/drizzle";
import { acpEvents } from "../db/schema/acp";

const state = z
  .object({
    requestId: z.string().uuid(),
    targetRequestId: z.string().uuid(),
    state: z.enum(["requested", "confirmed", "unknown"]),
  })
  .passthrough();
export type SalaamCancellationState = z.infer<typeof state>;
/** The owning session's durable intent/receipt history; never an ACP transport request id. */
export async function readSalaamCancellation(
  sessionId: string,
  requestId?: string,
): Promise<SalaamCancellationState | null> {
  const [event] = await db
    .select({ payload: acpEvents.payload })
    .from(acpEvents)
    .where(
      and(
        eq(acpEvents.sessionId, sessionId),
        eq(acpEvents.type, "state"),
        sql`${acpEvents.payload}->'cancellation' IS NOT NULL`,
        requestId
          ? sql`${acpEvents.payload} #>> '{cancellation,requestId}'=${requestId}`
          : undefined,
      ),
    )
    .orderBy(desc(acpEvents.seq))
    .limit(1);
  const payload = event?.payload as { cancellation?: unknown } | undefined;
  const parsed = state.safeParse(payload?.cancellation);
  return parsed.success ? parsed.data : null;
}
