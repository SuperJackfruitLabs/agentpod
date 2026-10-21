import { and, eq } from "drizzle-orm";
import { db } from "../../db/drizzle";
import { executionExports } from "../../db/schema/execution-evidence";
import type { ExportRecord, ExportStore } from "./execution-export";
export const executionExportStore: ExportStore = {
  async reserve(record) {
    await db.insert(executionExports).values(record).onConflictDoNothing();
    const [saved] = await db
      .select()
      .from(executionExports)
      .where(eq(executionExports.requestId, record.requestId));
    return saved as ExportRecord;
  },
  async get(requestId, tenantId, principalId) {
    const [saved] = await db
      .select()
      .from(executionExports)
      .where(
        and(
          eq(executionExports.requestId, requestId),
          eq(executionExports.tenantId, tenantId),
          eq(executionExports.principalId, principalId),
        ),
      );
    return (saved as ExportRecord) ?? null;
  },
  async change(requestId, from, to, patch = {}) {
    const changed = await db
      .update(executionExports)
      .set({
        status: to,
        ...(patch.uploadId ? { uploadId: patch.uploadId } : {}),
        ...(patch.receipt ? { receipt: patch.receipt } : {}),
      })
      .where(
        and(
          eq(executionExports.requestId, requestId),
          eq(executionExports.status, from),
        ),
      )
      .returning({ id: executionExports.requestId });
    return changed.length === 1;
  },
};
