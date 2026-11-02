/**
 * Characterization: the exact traffic of the ACP session service, pinned before it splits.
 *
 * sessions.test.ts proves the behaviours one by one (ordering, gates, permission modes, offline
 * grace, reconcile). This file pins the WHOLE of what each operation sends and writes, as it is
 * today, so a restructure that moves the code cannot change any of it unnoticed:
 *
 *   - the ACP messages the agent receives (method and params, in order),
 *   - the gateway verbs the node receives (in order, with their params),
 *   - the transcript (`acp_events`, every type and payload, in seq order) and the final row,
 *   - the audit row a prompt writes,
 *   - the error each exported operation throws for a session it cannot act on,
 *   - the node-online hook the module registers at load (one, recovery before orphan cleanup),
 *   - the same for a Salaam station: the authority verbs, the feature handshake, prompt receipts.
 *
 * Volatile values (ids, uuids, timestamps) are replaced by placeholders before comparing.
 * Uses the local Docker test-postgres (localhost:5434).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import type { DetectedStation } from "@agentpod/contract";
import { db, rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID, tenants } from "../../db/schema/tenants";
import { acpEvents, acpSessions } from "../../db/schema/acp";
import { nodes } from "../../db/schema/nodes";
import { stations } from "../../db/schema/stations";
import { createTestUser, deleteTestUsers } from "../../../tests/helpers/database";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { fakePlane } from "../../../tests/helpers/fake-plane";
import {
  connectFakeAcpNode,
  parsedNodeMsgs,
  pollUntil,
  type FakeAcpNode,
  type FakeAcpNodeOpts,
} from "../../../tests/helpers/acp-fake-node";
import { mintEnrollmentToken, enrollNode } from "../nodes/enrollment";
import { adoptStations } from "../stations/registry";
import { gatewayRoutes } from "../../routes/gateway";
import { websocket } from "../../ws";
import { connectionManager } from "../broker";
import {
  answerPermission,
  cancelTurn,
  createSession,
  endSession,
  getSession,
  promptSession,
  reconcileOnBoot,
  renewExecution,
  setMode,
  _setOfflineGraceMsForTest,
} from "./sessions";

const TEST_USER = "test-user-acpchar-001";
const testApp = new Hono().route("/public/nodes", gatewayRoutes);

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: TEST_USER, email: "acpchar@example.com", name: "ACP Characterization" });
});

afterAll(async () => {
  await rawSql`DELETE FROM acp_sessions      WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM station_audit     WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
  await deleteTestUsers([TEST_USER]);
});

// ─── Rig ──────────────────────────────────────────────────────────────────────

async function setupRig(hostname: string, opts: FakeAcpNodeOpts = {}) {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const { token } = await mintEnrollmentToken(TEST_USER, BOOTSTRAP_TENANT_ID);
  const { nodeId, nodeSecret } = await enrollNode(token, { hostname, os: "linux", arch: "amd64", cpuCount: 2 });
  const fake = await connectFakeAcpNode(Number(server.port), nodeId, nodeSecret, opts);
  const stationKey = opts.stationKey ?? "acp-char-station";
  const detected: DetectedStation[] = [
    {
      key: stationKey,
      harness: "opencode",
      kind: "leaf",
      displayName: "ACP Characterization",
      parentKey: null,
      workspacePath: "/workspace/acpchar",
      capabilities: ["health", "acp"],
      matrixId: null,
      adopted: false,
    },
  ];
  const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detected);
  if (!station) throw new Error("station adoption failed");
  return { server, nodeId, fake, station };
}

/** Replace ids, uuids and timestamps with placeholders, so the shape and every fixed value compare. */
function normalize(value: unknown, names: Record<string, string> = {}): unknown {
  let text = JSON.stringify(value);
  for (const [literal, name] of Object.entries(names)) text = text.split(literal).join(name);
  text = text
    .replace(/acps_[0-9a-f-]{36}/g, "<session>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
  return JSON.parse(text);
}

async function transcript(sessionId: string) {
  const rows = await db.select().from(acpEvents).where(eq(acpEvents.sessionId, sessionId)).orderBy(asc(acpEvents.seq));
  return rows.map((r) => [r.seq, r.type, r.payload]);
}

async function sessionRow(sessionId: string) {
  const [r] = await db.select().from(acpSessions).where(eq(acpSessions.id, sessionId));
  if (!r) return null;
  return {
    status: r.status,
    mode: r.mode,
    endedReason: r.endedReason,
    endedCause: r.endedCause,
    title: r.title,
    lastSeq: r.lastSeq,
    nodeSessionId: r.nodeSessionId,
    mcpProxyRequested: r.mcpProxyRequested,
    resumedFrom: r.resumedFrom,
    resumedAs: r.resumedAs,
    execution: r.executionAuthority ? { state: r.executionAuthority.state, sessionId: r.executionAuthority.sessionId } : null,
  };
}

/** What the agent processes received: method + params (or result, for answers to its requests). */
function agentTraffic(fake: FakeAcpNode) {
  return fake.agentReceived.map((m) =>
    m.method !== undefined ? { method: m.method, params: m.params } : { answer: m.id, result: m.result },
  );
}

/** The gateway requests the node received (verb + params), in order. Heartbeat-free by construction. */
function nodeVerbs(fake: FakeAcpNode) {
  return parsedNodeMsgs(fake.nodeMsgs)
    .filter((m) => m.type === "req")
    .map((m) => ({ verb: m.verb, params: m.params }));
}

async function waitForStatus(sessionId: string, status: string, timeoutMs = 8000) {
  await pollUntil(async () => (await getSession(TEST_USER, sessionId))?.status === status, timeoutMs);
}

async function waitForEvents(sessionId: string, count: number, timeoutMs = 8000) {
  await pollUntil(async () => (await transcript(sessionId)).length >= count, timeoutMs);
}

// ─── A turn, end to end ───────────────────────────────────────────────────────

test("a full turn: the handshake, the prompt, an ask-mode permission, the end — every message and event", async () => {
  const { server, fake, station } = await setupRig("acpchar-turn", {
    stationKey: "acp-char-turn",
    permission: { toolKind: "execute" },
  });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" });
    expect(normalize(row, { [station.id]: "<station>", [TEST_USER]: "<user>" })).toMatchInlineSnapshot(`
      {
        "createdAt": "<time>",
        "endedCause": null,
        "endedReason": null,
        "id": "<session>",
        "lastEventAt": "<time>",
        "lastSeq": 1,
        "mode": "ask",
        "resumable": false,
        "resumedAs": null,
        "resumedFrom": null,
        "stationId": "<station>",
        "status": "idle",
        "title": null,
        "userId": "<user>",
      }
    `);

    await promptSession(TEST_USER, row.id, "  Characterize this turn please  ");
    await waitForStatus(row.id, "waiting");
    const [request] = (await transcript(row.id)).filter(([, type]) => type === "permission-request");
    const requestSeq = request?.[0];
    if (typeof requestSeq !== "number") throw new Error("no permission request");
    await answerPermission(TEST_USER, row.id, requestSeq, "allow");
    await waitForStatus(row.id, "idle");
    await endSession(TEST_USER, row.id, "characterized");

    const names = { [row.id]: "<session>", [station.id]: "<station>", [TEST_USER]: "<user>" };
    expect(normalize(await transcript(row.id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "user-prompt",
          {
            "text": "  Characterize this turn please  ",
          },
        ],
        [
          3,
          "state",
          {
            "status": "working",
          },
        ],
        [
          4,
          "agent-update",
          {
            "content": {
              "text": "Working on it",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          5,
          "permission-request",
          {
            "options": [
              {
                "kind": "allow_once",
                "name": "Allow",
                "optionId": "allow",
              },
              {
                "kind": "reject_once",
                "name": "Reject",
                "optionId": "reject",
              },
            ],
            "toolCall": {
              "kind": "execute",
              "title": "Do the thing",
              "toolCallId": "tc-1",
            },
          },
        ],
        [
          6,
          "state",
          {
            "status": "waiting",
          },
        ],
        [
          7,
          "permission-answer",
          {
            "optionId": "allow",
            "requestSeq": 5,
          },
        ],
        [
          8,
          "state",
          {
            "status": "working",
          },
        ],
        [
          9,
          "agent-update",
          {
            "content": {
              "text": "Done",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          10,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          11,
          "state",
          {
            "reason": "characterized",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(await sessionRow(row.id), names)).toMatchInlineSnapshot(`
      {
        "endedCause": null,
        "endedReason": "characterized",
        "execution": null,
        "lastSeq": 11,
        "mcpProxyRequested": false,
        "mode": "ask",
        "nodeSessionId": null,
        "resumedAs": null,
        "resumedFrom": null,
        "status": "ended",
        "title": "Characterize this turn please",
      }
    `);
    expect(normalize(agentTraffic(fake), names)).toMatchInlineSnapshot(`
      [
        {
          "method": "initialize",
          "params": {
            "clientCapabilities": {},
            "clientInfo": {
              "name": "agentpod-hub",
              "version": "0.1.0",
            },
            "protocolVersion": 1,
          },
        },
        {
          "method": "session/new",
          "params": {
            "cwd": "/workspace/acpchar",
            "mcpServers": [],
          },
        },
        {
          "method": "session/prompt",
          "params": {
            "prompt": [
              {
                "text": "  Characterize this turn please  ",
                "type": "text",
              },
            ],
            "sessionId": "sess_agent_1",
          },
        },
        {
          "answer": "perm-acp-proc-1-1",
          "result": {
            "outcome": {
              "optionId": "allow",
              "outcome": "selected",
            },
          },
        },
      ]
    `);
    await pollUntil(() => nodeVerbs(fake).some((v) => v.verb === "acp.close"));
    expect(normalize(nodeVerbs(fake), names)).toMatchInlineSnapshot(`
      [
        {
          "params": {
            "instance": "<session>",
            "key": "acp-char-turn",
          },
          "verb": "acp.open",
        },
        {
          "params": {
            "sessionId": "acp-proc-1",
          },
          "verb": "acp.attach",
        },
        {
          "params": {
            "sessionId": "acp-proc-1",
          },
          "verb": "acp.close",
        },
      ]
    `);
    const audits = await rawSql`SELECT verb, params_summary, result, error FROM station_audit
      WHERE user_id=${TEST_USER} AND station_key=${station.stationKey} ORDER BY created_at`;
    expect(normalize(audits, names)).toMatchInlineSnapshot(`
      [
        {
          "error": null,
          "params_summary": {
            "chars": 33,
          },
          "result": "ok",
          "verb": "acp.prompt",
        },
      ]
    `);
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

test("full-auto and accept-edits: the auto answers' events, and setMode switching between them", async () => {
  const { server, fake, station } = await setupRig("acpchar-auto", {
    stationKey: "acp-char-auto",
    permission: { toolKind: "edit" },
  });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "full-auto" });
    await promptSession(TEST_USER, row.id, "first");
    await waitForStatus(row.id, "idle");
    await waitForEvents(row.id, 7);
    await setMode(TEST_USER, row.id, "accept-edits");
    await promptSession(TEST_USER, row.id, "second");
    await pollUntil(async () => (await transcript(row.id)).filter(([, t]) => t === "user-prompt").length === 2);
    await waitForStatus(row.id, "idle");
    await waitForEvents(row.id, 13);
    await endSession(TEST_USER, row.id, "done");
    const names = { [row.id]: "<session>" };
    expect(normalize(await transcript(row.id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "user-prompt",
          {
            "text": "first",
          },
        ],
        [
          3,
          "state",
          {
            "status": "working",
          },
        ],
        [
          4,
          "agent-update",
          {
            "content": {
              "text": "Working on it",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          5,
          "permission-request",
          {
            "auto": true,
            "options": [
              {
                "kind": "allow_once",
                "name": "Allow",
                "optionId": "allow",
              },
              {
                "kind": "reject_once",
                "name": "Reject",
                "optionId": "reject",
              },
            ],
            "toolCall": {
              "kind": "edit",
              "title": "Do the thing",
              "toolCallId": "tc-1",
            },
          },
        ],
        [
          6,
          "permission-answer",
          {
            "auto": true,
            "optionId": "allow",
            "requestSeq": 5,
          },
        ],
        [
          7,
          "agent-update",
          {
            "content": {
              "text": "Done",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          8,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          9,
          "user-prompt",
          {
            "text": "second",
          },
        ],
        [
          10,
          "state",
          {
            "status": "working",
          },
        ],
        [
          11,
          "agent-update",
          {
            "content": {
              "text": "Working on it",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          12,
          "permission-request",
          {
            "auto": true,
            "options": [
              {
                "kind": "allow_once",
                "name": "Allow",
                "optionId": "allow",
              },
              {
                "kind": "reject_once",
                "name": "Reject",
                "optionId": "reject",
              },
            ],
            "toolCall": {
              "kind": "edit",
              "title": "Do the thing",
              "toolCallId": "tc-1",
            },
          },
        ],
        [
          13,
          "permission-answer",
          {
            "auto": true,
            "optionId": "allow",
            "requestSeq": 12,
          },
        ],
        [
          14,
          "agent-update",
          {
            "content": {
              "text": "Done",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          15,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          16,
          "state",
          {
            "reason": "done",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(fake.permissionOutcomes)).toMatchInlineSnapshot(`
      [
        {
          "optionId": "allow",
          "outcome": "selected",
        },
        {
          "optionId": "allow",
          "outcome": "selected",
        },
      ]
    `);
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

test("cancelTurn on a hanging turn: the cancel notification and the events it leaves", async () => {
  const { server, fake, station } = await setupRig("acpchar-cancel", { stationKey: "acp-char-cancel", hangPrompt: true });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" });
    await promptSession(TEST_USER, row.id, "hang");
    await waitForStatus(row.id, "working");
    await waitForEvents(row.id, 4);
    await cancelTurn(TEST_USER, row.id);
    await waitForStatus(row.id, "idle");
    await new Promise((r) => setTimeout(r, 200));
    await endSession(TEST_USER, row.id, "done");
    const names = { [row.id]: "<session>" };
    expect(normalize(await transcript(row.id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "user-prompt",
          {
            "text": "hang",
          },
        ],
        [
          3,
          "state",
          {
            "status": "working",
          },
        ],
        [
          4,
          "agent-update",
          {
            "content": {
              "text": "Working on it",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          5,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          6,
          "state",
          {
            "reason": "done",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(agentTraffic(fake).filter((m) => "method" in m && m.method !== "initialize"), names)).toMatchInlineSnapshot(`
      [
        {
          "method": "session/new",
          "params": {
            "cwd": "/workspace/acpchar",
            "mcpServers": [],
          },
        },
        {
          "method": "session/prompt",
          "params": {
            "prompt": [
              {
                "text": "hang",
                "type": "text",
              },
            ],
            "sessionId": "sess_agent_1",
          },
        },
        {
          "method": "session/cancel",
          "params": {
            "sessionId": "sess_agent_1",
          },
        },
      ]
    `);
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

test("a rejected prompt: the error event, the audit result, the session back at idle", async () => {
  const { server, fake, station } = await setupRig("acpchar-fail", {
    stationKey: "acp-char-fail",
    failPrompt: "You exceeded your current quota",
    failPromptCode: -32603,
    failPromptData: { reason: "quota" },
  });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" });
    await promptSession(TEST_USER, row.id, "fail");
    await pollUntil(async () => (await transcript(row.id)).some(([, t]) => t === "error"));
    await waitForStatus(row.id, "idle");
    await endSession(TEST_USER, row.id, "done");
    const names = { [row.id]: "<session>" };
    expect(normalize(await transcript(row.id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "user-prompt",
          {
            "text": "fail",
          },
        ],
        [
          3,
          "state",
          {
            "status": "working",
          },
        ],
        [
          4,
          "error",
          {
            "harness": "opencode",
            "kind": "quota",
            "message": "You exceeded your current quota",
            "retryable": false,
            "source": "acp-rejection",
          },
        ],
        [
          5,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          6,
          "state",
          {
            "reason": "done",
            "status": "ended",
          },
        ],
      ]
    `);
    const audits = await rawSql`SELECT verb, params_summary, result, error FROM station_audit
      WHERE user_id=${TEST_USER} AND station_key=${station.stationKey} ORDER BY created_at`;
    expect(normalize(audits)).toMatchInlineSnapshot(`
      [
        {
          "error": "You exceeded your current quota",
          "params_summary": {
            "chars": 4,
          },
          "result": "error",
          "verb": "acp.prompt",
        },
      ]
    `);
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

test("the node goes away mid-session: waiting, then the grace end, and what the row keeps", async () => {
  _setOfflineGraceMsForTest(300);
  const { server, fake, station } = await setupRig("acpchar-offline", { stationKey: "acp-char-offline" });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" });
    fake.close();
    await waitForStatus(row.id, "ended");
    const names = { [row.id]: "<session>" };
    expect(normalize(await transcript(row.id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "state",
          {
            "reason": "node offline",
            "status": "waiting",
          },
        ],
        [
          3,
          "state",
          {
            "reason": "Couldn't reach the node.",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(await sessionRow(row.id), names)).toMatchInlineSnapshot(`
      {
        "endedCause": null,
        "endedReason": "Couldn't reach the node.",
        "execution": null,
        "lastSeq": 3,
        "mcpProxyRequested": false,
        "mode": "ask",
        "nodeSessionId": "acp-proc-1",
        "resumedAs": null,
        "resumedFrom": null,
        "status": "ended",
        "title": null,
      }
    `);
  } finally {
    _setOfflineGraceMsForTest(60_000);
    server.stop(true);
  }
}, 20_000);

/** How a call settled: "resolved", or the error's name and message. */
const errorOf = async (p: Promise<unknown>) =>
  p.then(
    () => "resolved",
    (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
  );

test("every operation's refusal for a session it cannot act on", async () => {
  const missing = "acps_00000000-0000-0000-0000-000000000000";
  expect({
    prompt: await errorOf(promptSession(TEST_USER, missing, "x")),
    answer: await errorOf(answerPermission(TEST_USER, missing, 1, "allow")),
    cancel: await errorOf(cancelTurn(TEST_USER, missing)),
    setMode: await errorOf(setMode(TEST_USER, missing, "ask")),
    end: await errorOf(endSession(TEST_USER, missing, "x")),
    renew: await errorOf(renewExecution(TEST_USER, missing)),
    createMissingStation: await errorOf(
      createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: "st_missing", userId: TEST_USER, mode: "ask" }),
    ),
  }).toMatchInlineSnapshot(`
    {
      "answer": "Error: Session not found or not active.",
      "cancel": "Error: Session not found or not active.",
      "createMissingStation": "Error: Station not found.",
      "end": "Error: Session not found.",
      "prompt": "Error: Session not found",
      "renew": "Error: Session not found or not active.",
      "setMode": "Error: Session not found.",
    }
  `);

  const { server, fake, station } = await setupRig("acpchar-refusals", { stationKey: "acp-char-refusals", legacyOpen: true });
  try {
    const row = await createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" });
    expect({
      secondOnLegacyNode: await errorOf(
        createSession({ tenantId: BOOTSTRAP_TENANT_ID, stationId: station.id, userId: TEST_USER, mode: "ask" }),
      ),
      answerNothingPending: await errorOf(answerPermission(TEST_USER, row.id, 99, "allow")),
      otherUserPrompt: await errorOf(promptSession("someone-else", row.id, "x")),
    }).toMatchInlineSnapshot(`
      {
        "answerNothingPending": "Error: No pending permission request.",
        "otherUserPrompt": "Error: Session not found",
        "secondOnLegacyNode": "Error: An active session already exists for this agent.",
      }
    `);
    await endSession(TEST_USER, row.id, "done");
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

// ─── Boot and node-online ─────────────────────────────────────────────────────

test("reconcileOnBoot on a stale row: the appended end, the close sent to its node, the marker cleared", async () => {
  const { server, fake, station } = await setupRig("acpchar-reconcile", { stationKey: "acp-char-reconcile" });
  const id = `acps_${crypto.randomUUID()}`;
  try {
    const now = new Date();
    await db.insert(acpSessions).values({
      id,
      tenantId: BOOTSTRAP_TENANT_ID,
      stationId: station.id,
      userId: TEST_USER,
      mode: "ask",
      status: "working",
      nodeSessionId: "stale-proc-9",
      createdAt: now,
      lastEventAt: now,
    });
    await db.insert(acpEvents).values({ sessionId: id, tenantId: BOOTSTRAP_TENANT_ID, seq: 1, type: "state", payload: { status: "idle" }, createdAt: now });
    await reconcileOnBoot();
    await pollUntil(() => nodeVerbs(fake).some((v) => v.verb === "acp.close"));
    await pollUntil(async () => (await sessionRow(id))?.nodeSessionId === null);
    const names = { [id]: "<session>" };
    expect(normalize(await transcript(id), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "state",
          {
            "reason": "hub restarted",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(await sessionRow(id), names)).toMatchInlineSnapshot(`
      {
        "endedCause": null,
        "endedReason": "hub restarted",
        "execution": null,
        "lastSeq": 2,
        "mcpProxyRequested": false,
        "mode": "ask",
        "nodeSessionId": null,
        "resumedAs": null,
        "resumedFrom": null,
        "status": "ended",
        "title": null,
      }
    `);
    expect(normalize(nodeVerbs(fake).filter((v) => v.verb !== "detect"), names)).toMatchInlineSnapshot(`
      [
        {
          "params": {
            "sessionId": "stale-proc-9",
          },
          "verb": "acp.close",
        },
      ]
    `);
  } finally {
    fake.close();
    server.stop(true);
  }
}, 20_000);

test("the module registers one node-online hook at load: Salaam recovery, then orphan cleanup", () => {
  // The hook list is private; read it as data, only to find the one this module registered.
  const registered: unknown = Reflect.get(connectionManager, "onlineHooks");
  const hooks: unknown[] = Array.isArray(registered) ? registered : [];
  const ours = hooks.filter((h) => String(h).includes("closeOrphanedProcesses"));
  expect(ours.length).toBe(1);
  const source = String(ours[0]);
  expect(source.indexOf("recoverSalaamForNode")).toBeGreaterThan(-1);
  expect(source.indexOf("recoverSalaamForNode")).toBeLessThan(source.indexOf("closeOrphanedProcesses"));
});

// ─── Salaam ───────────────────────────────────────────────────────────────────

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const salaam = {
  tenantId: "fleet_" + hex(),
  org: "org_" + hex(),
  user: "prn_" + hex(),
  agent: "prn_" + hex(),
  nodeId: "node_" + hex(),
  stationId: "station_" + hex(),
  secret: "fixture-secret-" + hex(),
  stationKey: "salaam:0123456789abcdef",
};

test("a Salaam session: the authority verbs, the feature handshake, the prompt receipts and the confirmed end", async () => {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  fakePlane.addHuman({ id: salaam.user, displayName: "Asha", grant: { mayDispatch: [salaam.agent] } });
  fakePlane.addAgent({ id: salaam.agent });
  for (const id of [salaam.user, salaam.agent]) {
    const principal = fakePlane.principals.get(id);
    if (principal) principal.organizationId = salaam.org;
  }
  await db.insert(tenants).values({ id: salaam.tenantId, name: "ACP characterization", externalSource: "org-plane", externalId: salaam.org });
  await db.insert(nodes).values({
    id: salaam.nodeId,
    tenantId: salaam.tenantId,
    userId: salaam.user,
    name: "char",
    hostname: "fixture",
    os: "linux",
    arch: "amd64",
    secretHash: await Bun.password.hash(salaam.secret),
  });
  await db.insert(stations).values({
    id: salaam.stationId,
    tenantId: salaam.tenantId,
    userId: salaam.user,
    nodeId: salaam.nodeId,
    harness: "salaam",
    stationKey: salaam.stationKey,
    kind: "leaf",
    displayName: "char",
    workspacePath: "/workspace",
    capabilities: ["acp"],
    principalId: salaam.agent,
  });
  const fake = await connectFakeAcpNode(Number(server.port), salaam.nodeId, salaam.secret, { stationKey: salaam.stationKey, salaam: {} });
  try {
    const row = await createSession({ stationId: salaam.stationId, tenantId: salaam.tenantId, userId: salaam.user, mode: "ask" });
    const receipt = await promptSession(salaam.user, row.id, "hello salaam", [], undefined, "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b");
    await pollUntil(async () => (await db.select().from(acpSessions).where(eq(acpSessions.id, row.id)))[0]?.status === "idle");
    await endSession(salaam.user, row.id, "characterized");
    const names = {
      [row.id]: "<session>",
      [salaam.stationId]: "<station>",
      [salaam.user]: "<user>",
      [salaam.agent]: "<agent>",
      [salaam.nodeId]: "<node>",
      [salaam.tenantId]: "<tenant>",
    };
    expect(normalize(receipt, names)).toMatchInlineSnapshot(`
      {
        "attemptId": null,
        "requestId": "<uuid>",
        "sessionId": "<session>",
        "state": "dispatched",
      }
    `);
    const events = await db.select().from(acpEvents).where(eq(acpEvents.sessionId, row.id)).orderBy(asc(acpEvents.seq));
    expect(normalize(events.map((e) => [e.seq, e.type, e.payload]), names)).toMatchInlineSnapshot(`
      [
        [
          1,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          2,
          "user-prompt",
          {
            "requestId": "<uuid>",
            "text": "hello salaam",
          },
        ],
        [
          3,
          "state",
          {
            "status": "working",
          },
        ],
        [
          4,
          "agent-update",
          {
            "content": {
              "text": "Working on it",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          5,
          "agent-update",
          {
            "content": {
              "text": "Done",
              "type": "text",
            },
            "sessionUpdate": "agent_message_chunk",
          },
        ],
        [
          6,
          "error",
          {
            "failureCode": "execution_interrupted",
            "harness": "salaam",
            "kind": "unknown",
            "localSessionId": "<uuid>",
            "logicalRequestId": "<uuid>",
            "message": 
      "[
        {
          "expected": "string",
          "code": "invalid_type",
          "path": [
            "requestId"
          ],
          "message": "Invalid input: expected string, received undefined"
        },
        {
          "expected": "string",
          "code": "invalid_type",
          "path": [
            "attemptId"
          ],
          "message": "Invalid input: expected string, received undefined"
        }
      ]"
      ,
            "source": "acp-rejection",
          },
        ],
        [
          7,
          "state",
          {
            "status": "idle",
          },
        ],
        [
          8,
          "state",
          {
            "execution": {
              "state": "revoked",
              "stopConfirmed": true,
            },
            "reason": "characterized",
            "status": "ended",
          },
        ],
      ]
    `);
    expect(normalize(agentTraffic(fake), names)).toMatchInlineSnapshot(`
      [
        {
          "method": "initialize",
          "params": {
            "clientCapabilities": {
              "_meta": {
                "salaam.dev/executionFeatures": {
                  "cancellationReceipts": 1,
                  "failures": 1,
                  "toolSemantics": 1,
                },
                "salaam.dev/features": {
                  "promptReceipts": 1,
                  "updateIds": 1,
                },
              },
            },
            "clientInfo": {
              "name": "agentpod-hub",
              "version": "0.1.0",
            },
            "protocolVersion": 1,
          },
        },
        {
          "method": "session/load",
          "params": {
            "cwd": "/workspace",
            "mcpServers": [],
            "sessionId": "<uuid>",
          },
        },
        {
          "method": "session/prompt",
          "params": {
            "_meta": {
              "salaam.dev/requestId": "<uuid>",
            },
            "prompt": [
              {
                "text": "hello salaam",
                "type": "text",
              },
            ],
            "sessionId": "<uuid>",
          },
        },
      ]
    `);
    expect(fake.salaamRequests.map((r) => r.verb)).toMatchInlineSnapshot(`
      [
        "salaam.admit",
        "salaam.renew",
        "salaam.renew",
        "salaam.revoke",
      ]
    `);
    const [ended] = await db.select().from(acpSessions).where(eq(acpSessions.id, row.id));
    expect(normalize({ status: ended?.status, endedReason: ended?.endedReason, state: ended?.executionAuthority?.state }, names)).toMatchInlineSnapshot(`
      {
        "endedReason": "characterized",
        "state": "revoked",
        "status": "ended",
      }
    `);
  } finally {
    fake.close();
    server.stop(true);
    await db.delete(acpSessions).where(eq(acpSessions.tenantId, salaam.tenantId));
    await rawSql`DELETE FROM station_audit WHERE tenant_id = ${salaam.tenantId}`;
    await db.delete(stations).where(eq(stations.tenantId, salaam.tenantId));
    await db.delete(nodes).where(eq(nodes.tenantId, salaam.tenantId));
    await db.delete(tenants).where(eq(tenants.id, salaam.tenantId));
    for (const id of [salaam.user, salaam.agent]) fakePlane.remove(id);
  }
}, 30_000);
