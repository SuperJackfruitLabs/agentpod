/** Checked: durable logical identity survives caller/transport changes and rejects changed input. */
import { SalaamAuthority } from "@agentpod/contract";
import { beforeAll, afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { acpSessions, acpPromptRequests } from "../../src/db/schema/acp";
import { tenants } from "../../src/db/schema/tenants";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import {
  bindSalaamPrompt,
  updateSalaamPrompt,
  getSalaamPrompt,
} from "../../src/services/salaam-prompts";
import { readEvents, getSession } from "../../src/services/acp-sessions";
import binding from "../../../../packages/contract/src/fixtures/salaam-authority-v1.json";
const sessionId = "acps_" + crypto.randomUUID(),
  userId = "prn_" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(acpSessions).values({
    id: sessionId,
    tenantId: BOOTSTRAP_TENANT_ID,
    stationId: binding.station_id,
    userId,
    mode: "ask",
    status: "idle",
    executionAuthority: {
      binding: SalaamAuthority.parse({ ...binding, hub_session_id: sessionId }),
      leaseSequence: 1,
      sessionId: crypto.randomUUID(),
      admissionId: crypto.randomUUID(),
      stopRequestId: "revoke:" + sessionId,
      state: "active",
    },
    createdAt: new Date(),
    lastEventAt: new Date(),
  });
});
afterAll(async () => {
  await db.delete(acpSessions).where(eq(acpSessions.id, sessionId));
});
test("concurrent identical requests bind one immutable logical instruction; changed or foreign input conflicts", async () => {
  const requestId = crypto.randomUUID();
  const bound = await Promise.all(
    Array.from({ length: 5 }, () =>
      bindSalaamPrompt(userId, sessionId, requestId, "one instruction"),
    ),
  );
  expect(bound.filter((x) => x.fresh)).toHaveLength(1);
  await expect(
    bindSalaamPrompt(userId, sessionId, requestId, "another instruction"),
  ).rejects.toThrow(/different input/);
  await expect(
    bindSalaamPrompt("foreign", sessionId, requestId, "one instruction"),
  ).rejects.toThrow(/not found/i);
  await expect(
    bindSalaamPrompt(userId, sessionId, "jsonrpc-7", "one instruction"),
  ).rejects.toThrow();
});
test("the database rejects a prompt ledger copied into a different tenant", async () => {
  const tenantId =
    "fleet_" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "Salaam recovery isolation proof" });
  try {
    await expect(
      Promise.resolve(
        db.insert(acpPromptRequests).values({
          sessionId,
          tenantId,
          requestId: crypto.randomUUID(),
          inputDigest: "test",
          inputText: "must not cross the session tenant",
          state: "prepared",
        }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint_name: "acp_prompt_requests_session_tenant_fk" },
    });
  } finally {
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
});
test("editor recovery cannot read another owner's or station's history", async () => {
  expect((await getSession(userId, sessionId))?.execution?.promptReceipts).toBe(
    1,
  );
  await expect(
    readEvents(sessionId, 0, {
      userId: "foreign",
      stationId: binding.station_id,
    }),
  ).rejects.toThrow(/not found/i);
  await expect(
    readEvents(sessionId, 0, { userId, stationId: "station_foreign" }),
  ).rejects.toThrow(/not found/i);
  expect(
    await readEvents(sessionId, 0, { userId, stationId: binding.station_id }),
  ).toEqual([]);
});
test("a terminal cancellation receipt can recover its original attempt without changing its outcome", async () => {
  const rows = await db
    .select()
    .from(acpPromptRequests)
    .where(eq(acpPromptRequests.sessionId, sessionId));
  for (const row of rows)
    await updateSalaamPrompt(sessionId, row.requestId, "interrupted");
  const requestId = crypto.randomUUID(),
    attemptId = crypto.randomUUID();
  await bindSalaamPrompt(
    userId,
    sessionId,
    requestId,
    "cancel before acceptance receipt",
  );
  await updateSalaamPrompt(sessionId, requestId, "interrupted");
  expect(
    await updateSalaamPrompt(sessionId, requestId, "accepted", attemptId),
  ).toMatchObject({ state: "interrupted", attemptId });
  await expect(
    updateSalaamPrompt(sessionId, requestId, "completed", crypto.randomUUID()),
  ).rejects.toThrow(/attempt/);
});
test("saved receipts survive end/revocation and cannot change attempts or regress a terminal outcome", async () => {
  // The previous prepared identity deliberately fences another instruction until reconciled.
  const rows = await db
    .select()
    .from(acpPromptRequests)
    .where(eq(acpPromptRequests.sessionId, sessionId));
  for (const row of rows)
    await updateSalaamPrompt(sessionId, row.requestId, "interrupted");
  const requestId = crypto.randomUUID(),
    attemptId = crypto.randomUUID();
  await bindSalaamPrompt(userId, sessionId, requestId, "saved receipt");
  await updateSalaamPrompt(sessionId, requestId, "accepted", attemptId);
  await updateSalaamPrompt(sessionId, requestId, "completed", attemptId);
  await updateSalaamPrompt(sessionId, requestId, "unknown");
  await expect(
    updateSalaamPrompt(sessionId, requestId, "accepted", crypto.randomUUID()),
  ).rejects.toThrow(/attempt/);
  await db
    .update(acpSessions)
    .set({ status: "ended" })
    .where(eq(acpSessions.id, sessionId));
  expect(await getSalaamPrompt(userId, sessionId, requestId)).toMatchObject({
    requestId,
    attemptId,
    state: "completed",
  });
  expect(
    (await bindSalaamPrompt(userId, sessionId, requestId, "saved receipt"))
      .fresh,
  ).toBe(false);
  await expect(
    bindSalaamPrompt(userId, sessionId, crypto.randomUUID(), "new work"),
  ).rejects.toThrow(/ended/);
  await expect(
    getSalaamPrompt("foreign", sessionId, requestId),
  ).rejects.toThrow(/not found/i);
});
