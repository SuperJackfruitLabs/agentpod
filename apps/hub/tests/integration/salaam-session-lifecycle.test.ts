/**
 * Salaam session lifecycle (operator decision, 2026-10-23): a Salaam station keeps its one live
 * execution at a time, but an idle session ends on its own, an ended one can be resumed under a
 * fresh authority, the refusal names who holds the station, and a workspace admin can end someone
 * else's session. Real hub service and gateway, a fake node speaking Salaam's authority verbs.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { tenants } from "../../src/db/schema/tenants";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { acpEvents, acpSessions } from "../../src/db/schema/acp";
import { adminAuditLog } from "../../src/db/schema/admin";
import { gatewayRoutes } from "../../src/routes/gateway";
import { stationAcpRoutes, createSessionFailure } from "../../src/routes/station-acp";
import { websocket } from "../../src/ws";
import * as acp from "../../src/services/acp-sessions";
import { connectFakeAcpNode, type FakeAcpNode } from "../helpers/acp-fake-node";
import { fakePlane } from "../helpers/fake-plane";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import type { AuthUser } from "../../src/auth/middleware";

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenantId = "fleet_" + hex(),
  org = "org_" + hex(),
  asha = "prn_" + hex(),
  bilal = "prn_" + hex(),
  chitra = "prn_" + hex(),
  agent = "prn_" + hex();
const nodeId = "node_" + hex(),
  stationId = "station_" + hex(),
  nodeSecret = "fixture-secret-" + hex();
const server = Bun.serve({ fetch: new Hono().route("/public/nodes", gatewayRoutes).fetch, websocket, port: 0 });
let fake: FakeAcpNode;

const user = (id: string, workspaceRole: "member" | "admin"): AuthUser =>
  ({ id, authType: "org_plane", tenantId, org, workspaceRole }) as AuthUser;
/** The console's routes, as `as`. */
function routes(as: AuthUser) {
  return new Hono()
    .use(async (c, next) => {
      c.set("user" as never, as as never);
      await next();
    })
    .route("/api", stationAcpRoutes);
}
const open = (userId: string) => acp.createSession({ stationId, tenantId, userId, mode: "ask" });
const row = async (id: string) => (await db.select().from(acpSessions).where(eq(acpSessions.id, id)))[0]!;
const post = (path: string) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

beforeAll(async () => {
  await ensurePgMigrations();
  fakePlane.addHuman({ id: asha, displayName: "Asha", grant: { mayDispatch: [agent] } });
  fakePlane.addHuman({ id: bilal, displayName: "Bilal", grant: { mayDispatch: [agent] } });
  fakePlane.addHuman({ id: chitra, displayName: "Chitra", grant: { mayDispatch: [] } });
  fakePlane.addAgent({ id: agent });
  for (const id of [asha, bilal, chitra, agent]) fakePlane.principals.get(id)!.organizationId = org;
  await db.insert(tenants).values({ id: tenantId, name: "Salaam lifecycle proof", externalSource: "org-plane", externalId: org });
  await db.insert(nodes).values({
    id: nodeId,
    tenantId,
    userId: asha,
    name: "lifecycle",
    hostname: "fixture",
    os: "linux",
    arch: "amd64",
    secretHash: await Bun.password.hash(nodeSecret),
  });
  await db.insert(stations).values({
    id: stationId,
    tenantId,
    userId: asha,
    nodeId,
    harness: "salaam",
    stationKey: "salaam:c52ddf65534b7b46",
    kind: "leaf",
    displayName: "lifecycle",
    workspacePath: "/workspace",
    capabilities: ["acp"],
    principalId: agent,
  });
  fake = await connectFakeAcpNode(server.port!, nodeId, nodeSecret, {
    stationKey: "salaam:c52ddf65534b7b46",
    salaam: {},
  });
});
afterEach(async () => {
  for (const r of await db.select().from(acpSessions).where(eq(acpSessions.tenantId, tenantId)))
    if (r.status !== "ended") await acp.endSessionAsWorkspaceAdmin(tenantId, r.id, "cleanup").catch(() => {});
  fake.opts.salaam = {};
  await fakePlane.putGrant(chitra, { mayDispatch: [], mayGrantReach: false, scopes: [] });
});
afterAll(async () => {
  fake.close();
  server.stop(true);
  await db.delete(adminAuditLog).where(eq(adminAuditLog.tenantId, tenantId));
  await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  for (const id of [asha, bilal, chitra, agent]) fakePlane.remove(id);
});

test("the one-at-a-time refusal names the holder and since when; for yourself it links the session", async () => {
  const held = await open(asha);
  let refused: unknown;
  await open(bilal).catch((e) => (refused = e));
  expect(acp.isSalaamStationBusy(refused)).toBe(true);
  const failure = createSessionFailure(refused);
  expect(failure.status).toBe(424);
  expect(failure.body).toMatchObject({
    code: "station_busy",
    holder: { name: "Asha", you: false, state: "active", since: held.createdAt },
  });
  // Someone else's session id is not handed out.
  expect((failure.body as { holder: object }).holder).not.toHaveProperty("sessionId");
  expect((failure.body as { error: string }).error).toContain("Asha is in a session with this agent since");

  let mine: unknown;
  await open(asha).catch((e) => (mine = e));
  expect(createSessionFailure(mine).body).toMatchObject({
    code: "station_busy",
    holder: { name: "You", you: true, sessionId: held.id },
  });
});

test("an idle session ends on its own through the confirmed stop, and the station is free again", async () => {
  const held = await open(asha);
  const idleMs = acp.salaamIdleEndMs({ SALAAM_IDLE_END_MINUTES: "15" });
  expect(idleMs).toBe(15 * 60_000);
  const opened = Date.now();
  // Not yet: five seconds short of the timeout.
  expect(await acp.endIdleSalaamSessions(opened + idleMs - 5_000, idleMs)).toEqual([]);
  expect((await row(held.id)).status).not.toBe("ended");

  expect(await acp.endIdleSalaamSessions(Date.now() + idleMs, idleMs)).toEqual([held.id]);
  const ended = await row(held.id);
  expect(ended.status).toBe("ended");
  expect(ended.endedCause).toBe("idle");
  expect(ended.endedReason).toBe("Ended after 15 minutes without activity. Resume it to carry on.");
  // Ended through revocation the node confirmed, not just a closed wire.
  expect(ended.executionAuthority?.state).toBe("revoked");
  expect(
    fake.salaamRequests.some(
      (r) => r.verb === "salaam.revoke" && (r.params.binding as { hub_session_id: string }).hub_session_id === held.id,
    ),
  ).toBe(true);
  // The station takes the next person.
  const next = await open(bilal);
  expect(next.status).toBe("idle");
});

test("resume carries the conversation into a new session on a fresh authority, once, owner only", async () => {
  const first = await open(asha);
  await acp.endIdleSalaamSessions(Date.now() + 16 * 60_000, 15 * 60_000);
  // Something said in the first session (written as the transcript would hold it), after its
  // end so no live seq counter races these rows.
  const { tenantId: tenant, lastSeq: last } = await row(first.id);
  await db.insert(acpEvents).values([
    { sessionId: first.id, tenantId: tenant, seq: last + 1, type: "user-prompt", payload: { text: "Remember the word mango" }, createdAt: new Date() },
    {
      sessionId: first.id,
      tenantId: tenant,
      seq: last + 2,
      type: "agent-update",
      payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Mango." } },
      createdAt: new Date(),
    },
  ]);
  await db.update(acpSessions).set({ lastSeq: last + 2 }).where(eq(acpSessions.id, first.id));
  expect((await acp.listSessions(asha, stationId)).find((s) => s.id === first.id)?.resumable).toBe(true);

  // Someone else cannot resume it, even a person who could chat with the agent themselves.
  const asBilal = await routes(user(bilal, "member")).request(`/api/acp/sessions/${first.id}/resume`, post(""));
  expect(asBilal.status).toBe(404);

  const res = await routes(user(asha, "member")).request(`/api/acp/sessions/${first.id}/resume`, post(""));
  expect(res.status).toBe(201);
  const resumed = (await res.json()) as { id: string; resumedFrom: string };
  expect(resumed.id).not.toBe(first.id);
  expect(resumed.resumedFrom).toBe(first.id);
  const before = await row(first.id),
    after = await row(resumed.id);
  expect(before.resumedAs).toBe(resumed.id);
  // A fresh execution authority: its own binding and admission, asked of Salaam as a continuation.
  expect(after.executionAuthority?.state).toBe("active");
  expect(after.executionAuthority?.binding.hub_session_id).toBe(resumed.id);
  expect(after.executionAuthority?.admissionId).not.toBe(before.executionAuthority?.admissionId);
  expect(after.executionAuthority?.continueFrom).toBe(first.id);
  const admit = fake.salaamRequests.find(
    (r) => r.verb === "salaam.admit" && (r.params.binding as { hub_session_id: string }).hub_session_id === resumed.id,
  );
  expect(admit?.params.continue_from).toBe(first.id);
  // The old authority stays revoked.
  expect(before.executionAuthority?.state).toBe("revoked");
  // The conversation reads as one: the old turns, renumbered, and no "ended" carried over.
  const events = await db.select().from(acpEvents).where(eq(acpEvents.sessionId, resumed.id)).orderBy(asc(acpEvents.seq));
  expect(events.slice(0, 2).map((e) => [e.seq, e.type])).toEqual([
    [1, "user-prompt"],
    [2, "agent-update"],
  ]);
  expect(events.some((e) => e.type === "state" && (e.payload as { status?: string }).status === "ended")).toBe(false);
  expect(events.at(-1)?.payload).toMatchObject({ status: "idle", resumedFrom: first.id });

  // Once: the same conversation never forks into two branches.
  await acp.endSession(asha, resumed.id, "done");
  await expect(acp.resumeSession({ sessionId: first.id, tenantId, userId: asha })).rejects.toThrow(/already resumed/);
});

test("resume passes the same checks as a new session: the station's holder and the person's own authority", async () => {
  const first = await open(asha);
  await acp.endSession(asha, first.id, "done");
  const other = await open(bilal);
  let refused: unknown;
  await acp.resumeSession({ sessionId: first.id, tenantId, userId: asha }).catch((e) => (refused = e));
  expect(createSessionFailure(refused).body).toMatchObject({ code: "station_busy", holder: { name: "Bilal" } });
  // A refused resume does not use the conversation up.
  expect((await row(first.id)).resumedAs).toBeNull();
  await acp.endSession(bilal, other.id, "done");

  // Chitra opened a session while she held a grant, then lost it.
  await fakePlane.putGrant(chitra, { mayDispatch: [agent], mayGrantReach: false, scopes: [] });
  const hers = await open(chitra);
  await acp.endSession(chitra, hers.id, "done");
  await fakePlane.putGrant(chitra, { mayDispatch: [], mayGrantReach: false, scopes: [] });
  // As a member her resume is refused like any new session...
  await expect(
    acp.resumeSession({ sessionId: hers.id, tenantId, userId: chitra, workspaceRole: "member" }),
  ).rejects.toThrow(/withdrawn|grant/i);
  // ...and as a workspace admin decision 3 admits her interactive chat.
  const resumed = await acp.resumeSession({ sessionId: hers.id, tenantId, userId: chitra, workspaceRole: "admin" });
  expect((await row(resumed.id)).executionAuthority?.workspaceAdmin).toBe(true);
});

test("two resumes racing past the first check still claim the conversation once", async () => {
  const first = await open(asha);
  await acp.endSession(asha, first.id, "done");
  // Salaam admits the continuation, then the agent fails to open: the conversation went to that
  // attempt, so the claim stays with it. The second resume read "not yet resumed" before the first
  // claimed, so only the conditional claim stops it from forking the conversation.
  fake.opts.failOpen = "agent would not start";
  try {
    const [a, b] = await Promise.allSettled([
      acp.resumeSession({ sessionId: first.id, tenantId, userId: asha }),
      acp.resumeSession({ sessionId: first.id, tenantId, userId: asha }),
    ]);
    const reasons = [a, b].map((r) => (r.status === "rejected" ? String((r.reason as Error).message) : "resolved"));
    expect(reasons.filter((m) => /already resumed/.test(m))).toHaveLength(1);
    const claimedBy = (await row(first.id)).resumedAs;
    expect(claimedBy).not.toBeNull();
    const branches = await db.select().from(acpSessions).where(eq(acpSessions.resumedFrom, first.id));
    expect(branches.filter((r) => r.executionAuthority?.sessionId).map((r) => r.id)).toEqual([claimedBy!]);
  } finally {
    fake.opts.failOpen = undefined;
  }
});

test("an older Salaam that cannot continue a conversation fails the resume instead of starting empty", async () => {
  const first = await open(asha);
  await acp.endSession(asha, first.id, "done");
  fake.opts.salaam = { oldDaemon: true };
  await expect(acp.resumeSession({ sessionId: first.id, tenantId, userId: asha })).rejects.toThrow(/Upgrade Salaam/);
});

test("a workspace admin ends another person's session through the confirmed stop, audited; a member cannot", async () => {
  const held = await open(asha);
  const asBilal = await routes(user(bilal, "member")).request(`/api/acp/sessions/${held.id}`, { method: "DELETE" });
  expect(asBilal.status).toBe(404);
  expect((await row(held.id)).status).not.toBe("ended");

  // The admin's workspace list names whose sessions they are.
  const list = await routes(user(chitra, "admin")).request(`/api/stations/${stationId}/acp/sessions?scope=workspace`);
  const rows = (await list.json()) as Array<{ id: string; owner: { name: string; you: boolean } }>;
  expect(rows.find((r) => r.id === held.id)?.owner).toEqual({ name: "Asha", you: false });
  // A member asking for the workspace list still sees only their own.
  const memberList = await routes(user(bilal, "member")).request(`/api/stations/${stationId}/acp/sessions?scope=workspace`);
  expect(((await memberList.json()) as Array<{ id: string }>).some((r) => r.id === held.id)).toBe(false);

  const asChitra = await routes(user(chitra, "admin")).request(`/api/acp/sessions/${held.id}`, { method: "DELETE" });
  expect(asChitra.status).toBe(204);
  const ended = await row(held.id);
  expect(ended.status).toBe("ended");
  expect(ended.endedCause).toBe("admin");
  expect(ended.executionAuthority?.state).toBe("revoked");
  const audit = await db
    .select()
    .from(adminAuditLog)
    .where(and(eq(adminAuditLog.tenantId, tenantId), eq(adminAuditLog.targetResourceId, held.id)));
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ adminUserId: chitra, action: "acp_session_end", targetUserId: asha });
  // Admins see others' sessions but never resume them.
  const after = await routes(user(chitra, "admin")).request(`/api/stations/${stationId}/acp/sessions?scope=workspace`);
  expect(((await after.json()) as Array<{ id: string; resumable?: boolean }>).find((r) => r.id === held.id)?.resumable).toBe(false);
});

test("an end racing recovery after a hub restart leaves no restored ghost holding the station (#773)", async () => {
  const held = await open(asha);
  // The hub restarts: the row is active, nothing is live.
  acp._forgetLiveForTest(held.id);
  // Recovery has read the row (still active); before it restores, the person ends the session.
  let afterEnd = 0;
  acp._setSalaamRestoreBeforeLockForTest(async () => {
    acp._setSalaamRestoreBeforeLockForTest(undefined);
    await acp.endSession(asha, held.id, "done");
    afterEnd = fake.salaamRequests.length;
    unsubscribe = acp.subscribe(held.id, (e) => published.push(e.type));
  });
  const published: string[] = [];
  let unsubscribe: (() => void) | undefined;
  try {
    await acp.recoverSalaamForNode(nodeId);
  } finally {
    acp._setSalaamRestoreBeforeLockForTest(undefined);
    unsubscribe?.();
  }
  // A restored ghost would write its own end (or recovery error) onto this transcript.
  expect(published).toEqual([]);
  // Recovery did not restore the ended session: it sent the node nothing for it.
  const restoredFor = fake.salaamRequests
    .slice(afterEnd)
    .filter((r) => JSON.stringify(r.params).includes(held.id));
  expect(restoredFor).toEqual([]);
  expect((await row(held.id)).status).toBe("ended");
  const seqs = (await db.select().from(acpEvents).where(eq(acpEvents.sessionId, held.id))).map((e) => e.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  // The station is free: recovery did not resurrect the ended session.
  const next = await open(asha);
  expect(next.id).not.toBe(held.id);
});
