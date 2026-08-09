/**
 * Route Test: ACP session REST + console session WebSocket (Slice 2, Task 5)
 *
 * Verifies src/routes/station-acp.ts:
 *   REST:
 *     1. POST /api/stations/:id/acp/sessions {mode} → 201 AcpSessionRow;
 *        error statuses: 400 invalid mode, 401 anonymous, 403 no acp
 *        capability, 404 unknown station, 409 active session exists,
 *        502 node offline / acp.open failure.
 *     2. GET /api/stations/:id/acp/sessions → rows newest first.
 *   WS (GET /api/acp/sessions/:sessionId/ws):
 *     3. subscribe → session row, replay of persisted events (seq order),
 *        replay-done, then live events stream; prompt over the WS produces
 *        agent-update events.
 *     4. Client disconnect does NOT end the session (hub-owned); a second WS
 *        subscribe replays everything.
 *     5. Unauthenticated / wrong-user upgrade → closed; invalid client
 *        message → error event, socket stays usable (not closed).
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import type { AcpEvent, AcpSessionRow, DetectedStation } from "@agentpod/contract";

// src/ imports — DB URL is already set above
import { rawSql } from "../db/drizzle";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import {
  connectFakeAcpNode,
  pollUntil,
  type FakeAcpNodeOpts,
} from "../../tests/helpers/acp-fake-node";
import { mintEnrollmentToken, enrollNode } from "../services/enrollment";
import { adoptStations } from "../services/station-registry";
import {
  endSession,
  getSession,
  _subscriberCountForTest,
} from "../services/acp-sessions";
import { gatewayRoutes } from "./gateway";
import { stationAcpRoutes } from "./station-acp";
import { websocket } from "../ws";
import type { AuthUser } from "../auth/middleware";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-acproute-001";
const OTHER_USER = "test-user-acproute-002";

// ─── Minimal test app ─────────────────────────────────────────────────────────

// Mirrors station-terminal.test.ts: fake auth middleware + real gateway + routes.
const testApp = new Hono()
  .use("/api/*", async (c, next) => {
    const userId = c.req.header("X-Test-User-Id");
    if (userId && userId !== "anonymous") {
      c.set("user", { id: userId, authType: "api_key" } satisfies AuthUser);
    } else {
      c.set("user", { id: "anonymous", authType: "api_key" } satisfies AuthUser);
    }
    return next();
  })
  .route("/public/nodes", gatewayRoutes)
  .route("/api", stationAcpRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "acproute-test@example.com",
    name: "ACP Route Test User",
  });
  await createTestUser({
    id: OTHER_USER,
    email: "acproute-other@example.com",
    name: "ACP Route Other User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM acp_sessions      WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM station_audit     WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM stations          WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM nodes             WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id IN (${TEST_USER}, ${OTHER_USER})`;
    await rawSql`DELETE FROM "user"            WHERE id IN (${TEST_USER}, ${OTHER_USER})`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function enrollTestNode(hostname: string) {
  const { token } = await mintEnrollmentToken(TEST_USER);
  return enrollNode(token, {
    hostname,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
}

function detectedFor(
  stationKey: string,
  capabilities: string[],
  workspacePath = "/workspace/acproute"
): DetectedStation[] {
  return [
    {
      key: stationKey,
      harness: "opencode",
      kind: "leaf",
      displayName: "ACP Route Test",
      parentKey: null,
      workspacePath,
      capabilities,
      matrixId: null,
      adopted: false,
    },
  ];
}

/** Boot a gateway server + fake ACP node + adopted station for TEST_USER. */
async function setupRig(hostname: string, opts: FakeAcpNodeOpts = {}) {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const { nodeId, nodeSecret } = await enrollTestNode(hostname);
  const fake = await connectFakeAcpNode(server.port!, nodeId, nodeSecret, opts);
  const stationKey = opts.stationKey ?? "acp-sess-station";
  const [station] = await adoptStations(
    TEST_USER,
    nodeId,
    [stationKey],
    detectedFor(stationKey, ["health", "acp"], opts.workspacePath ?? "/workspace/acptest")
  );
  if (!station) throw new Error("station adoption failed");
  return { server, nodeId, fake, station, baseUrl: `http://localhost:${server.port}` };
}

function createSessionReq(
  baseUrl: string,
  stationId: string,
  body: unknown,
  userId: string | null = TEST_USER
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (userId) headers["X-Test-User-Id"] = userId;
  return fetch(`${baseUrl}/api/stations/${stationId}/acp/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

interface WsClient {
  ws: WebSocket;
  msgs: Array<Record<string, unknown>>;
  opened: Promise<void>;
  getCloseCode: () => number | null;
}

function connectClientWs(
  port: number,
  sessionId: string,
  userId?: string
): WsClient {
  const msgs: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(
    `ws://localhost:${port}/api/acp/sessions/${sessionId}/ws`,
    (userId
      ? { headers: { "X-Test-User-Id": userId } }
      : undefined) as RequestInit & { headers: Record<string, string> }
  );
  let closeCode: number | null = null;
  ws.onmessage = (e) => {
    try {
      msgs.push(JSON.parse(String(e.data)) as Record<string, unknown>);
    } catch {
      // Non-JSON frame — ignore.
    }
  };
  ws.onclose = (e) => {
    closeCode = e.code;
  };
  const opened = new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
    ws.onerror = () => resolve();
  });
  return { ws, msgs, opened, getCloseCode: () => closeCode };
}

/** Events (t:"event") received so far, unwrapped. */
function receivedEvents(client: WsClient): AcpEvent[] {
  return client.msgs
    .filter((m) => m.t === "event")
    .map((m) => m.event as AcpEvent);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "POST create → 201 idle row; 400 invalid mode; 401 anonymous; 403 no capability; 404 unknown station; 409 duplicate; GET lists newest first",
  async () => {
    const { server, nodeId, fake, station, baseUrl } = await setupRig(
      "acproute-rest-host"
    );
    try {
      // A second station on the same node WITHOUT the acp capability.
      const [noAcpStation] = await adoptStations(
        TEST_USER,
        nodeId,
        ["acproute-no-acp"],
        detectedFor("acproute-no-acp", ["health"])
      );
      if (!noAcpStation) throw new Error("no-acp station adoption failed");

      // 400 — invalid mode.
      const badMode = await createSessionReq(baseUrl, station.id, {
        mode: "yolo",
      });
      expect(badMode.status).toBe(400);

      // 401 — anonymous.
      const anon = await createSessionReq(baseUrl, station.id, { mode: "ask" }, null);
      expect(anon.status).toBe(401);

      // 404 — unknown station.
      const missing = await createSessionReq(baseUrl, "st_does-not-exist", {
        mode: "ask",
      });
      expect(missing.status).toBe(404);

      // 403 — station without the acp capability.
      const noCap = await createSessionReq(baseUrl, noAcpStation.id, {
        mode: "ask",
      });
      expect(noCap.status).toBe(403);

      // 201 — happy path.
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;
      expect(row.stationId).toBe(station.id);
      expect(row.userId).toBe(TEST_USER);
      expect(row.mode).toBe("ask");
      expect(row.status).toBe("idle");

      // 409 — an active session already exists.
      const dup = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(dup.status).toBe(409);

      // End it, create a second one; GET must list newest first.
      await endSession(TEST_USER, row.id, "test done");
      await new Promise((r) => setTimeout(r, 20)); // distinct createdAt
      const created2 = await createSessionReq(baseUrl, station.id, {
        mode: "full-auto",
      });
      expect(created2.status).toBe(201);
      const row2 = (await created2.json()) as AcpSessionRow;

      const listRes = await fetch(
        `${baseUrl}/api/stations/${station.id}/acp/sessions`,
        { headers: { "X-Test-User-Id": TEST_USER } }
      );
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()) as AcpSessionRow[];
      expect(listed.length).toBe(2);
      expect(listed[0]!.id).toBe(row2.id); // newest first
      expect(listed[1]!.id).toBe(row.id);

      // GET on an unknown station → 404.
      const listMissing = await fetch(
        `${baseUrl}/api/stations/st_does-not-exist/acp/sessions`,
        { headers: { "X-Test-User-Id": TEST_USER } }
      );
      expect(listMissing.status).toBe(404);

      await endSession(TEST_USER, row2.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "POST create → 502 when the node is offline and 502 when acp.open fails",
  async () => {
    // Offline node: enrolled but never connected to the gateway.
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    const baseUrl = `http://localhost:${server.port}`;
    try {
      const { nodeId } = await enrollTestNode("acproute-offline-host");
      const [station] = await adoptStations(
        TEST_USER,
        nodeId,
        ["acproute-offline"],
        detectedFor("acproute-offline", ["health", "acp"])
      );
      if (!station) throw new Error("station adoption failed");

      const offline = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(offline.status).toBe(502);

      // Online node whose acp.open fails.
      const { nodeId: failNodeId, nodeSecret } = await enrollTestNode(
        "acproute-failopen-host"
      );
      const fake = await connectFakeAcpNode(server.port!, failNodeId, nodeSecret, {
        stationKey: "acproute-failopen",
        failOpen: "agent binary missing",
      });
      const [failStation] = await adoptStations(
        TEST_USER,
        failNodeId,
        ["acproute-failopen"],
        detectedFor("acproute-failopen", ["health", "acp"])
      );
      if (!failStation) throw new Error("station adoption failed");

      const openFail = await createSessionReq(baseUrl, failStation.id, {
        mode: "ask",
      });
      expect(openFail.status).toBe(502);

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "WS subscribe → session row + replay + replay-done, then live events; prompt over WS produces agent-update",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-ws-host",
      { stationKey: "acproute-ws" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      const client = connectClientWs(server.port!, row.id, TEST_USER);
      await client.opened;
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));

      // session row arrives first.
      const sessionMsg = await pollUntil(() =>
        client.msgs.find((m) => m.t === "session")
      );
      expect((sessionMsg.session as AcpSessionRow).id).toBe(row.id);

      // Replay: the state-idle event from createSession (seq 1), then replay-done.
      const replayDone = await pollUntil(() =>
        client.msgs.find((m) => m.t === "replay-done")
      );
      expect(replayDone.lastSeq).toBe(1);
      const replayed = receivedEvents(client);
      expect(replayed.length).toBe(1);
      expect(replayed[0]!.seq).toBe(1);
      expect(replayed[0]!.type).toBe("state");
      // replay-done comes AFTER the replayed event.
      expect(client.msgs.findIndex((m) => m.t === "replay-done")).toBeGreaterThan(
        client.msgs.findIndex((m) => m.t === "event")
      );

      // Prompt over the WS → live user-prompt, agent-update(s), back to idle.
      client.ws.send(JSON.stringify({ t: "prompt", text: "do the thing" }));

      await pollUntil(() =>
        receivedEvents(client).find(
          (e) =>
            e.type === "state" &&
            (e.payload as { status?: string }).status === "idle" &&
            e.seq > 1
        )
      );
      const events = receivedEvents(client);
      const types = events.map((e) => e.type);
      expect(types).toContain("user-prompt");
      expect(types).toContain("agent-update");
      const update = events.find((e) => e.type === "agent-update")!;
      expect(JSON.stringify(update.payload)).toContain("Working on it");
      // seq strictly increasing across replay + live.
      const seqs = events.map((e) => e.seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
      }

      client.ws.close();
      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "client disconnect does NOT end the session; a second WS subscribe replays everything",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-disc-host",
      { stationKey: "acproute-disc" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      // First client: subscribe, prompt, wait for the turn to finish.
      const first = connectClientWs(server.port!, row.id, TEST_USER);
      await first.opened;
      first.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      await pollUntil(() => first.msgs.find((m) => m.t === "replay-done"));
      first.ws.send(JSON.stringify({ t: "prompt", text: "hello" }));
      await pollUntil(() =>
        receivedEvents(first).find(
          (e) =>
            e.type === "state" &&
            (e.payload as { status?: string }).status === "idle" &&
            e.seq > 1
        )
      );
      const seenLive = receivedEvents(first);
      const maxSeq = Math.max(...seenLive.map((e) => e.seq));

      // Disconnect. The session is hub-owned and must survive.
      first.ws.close();
      await new Promise((r) => setTimeout(r, 200));

      const after = await getSession(TEST_USER, row.id);
      expect(after).not.toBeNull();
      expect(after!.status).not.toBe("ended");

      // Second client replays EVERYTHING from seq 0.
      const second = connectClientWs(server.port!, row.id, TEST_USER);
      await second.opened;
      second.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      const replayDone = await pollUntil(() =>
        second.msgs.find((m) => m.t === "replay-done")
      );
      expect(replayDone.lastSeq).toBe(maxSeq);
      const replayed = receivedEvents(second);
      expect(replayed.map((e) => e.seq)).toEqual(
        Array.from({ length: maxSeq }, (_, i) => i + 1)
      );

      second.ws.close();
      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "disconnect during subscribe's awaits does not leak a live subscriber (regression: unsubscribe-null race)",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-leak-host",
      { stationKey: "acproute-leak" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      // Race the close frame against handleSubscribe's DB awaits: send
      // subscribe and close IMMEDIATELY, several times. Without the closed
      // guard, onClose runs while unsubscribe is still null, then
      // handleSubscribe resumes and registers a subscriber nothing removes.
      for (let i = 0; i < 10; i++) {
        const client = connectClientWs(server.port!, row.id, TEST_USER);
        await client.opened;
        // Let onOpen's ownership lookup settle so the message gate is open
        // and the race lands inside handleSubscribe itself.
        await new Promise((r) => setTimeout(r, 50));
        client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
        client.ws.close();
      }

      // Every subscriber must be gone once the sockets are down.
      await pollUntil(() => _subscriberCountForTest(row.id) === 0, 5000);

      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "a second valid subscribe replaces the first subscription — one live subscriber, no double delivery",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-resub-host",
      { stationKey: "acproute-resub" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      const client = connectClientWs(server.port!, row.id, TEST_USER);
      await client.opened;
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      await pollUntil(() => client.msgs.find((m) => m.t === "replay-done"));

      // Re-subscribe on the SAME socket: replaces, not stacks.
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      await pollUntil(
        () => client.msgs.filter((m) => m.t === "replay-done").length >= 2
      );
      expect(_subscriberCountForTest(row.id)).toBe(1);

      // A subsequent live event is delivered exactly once.
      client.ws.send(JSON.stringify({ t: "prompt", text: "once please" }));
      await pollUntil(() =>
        receivedEvents(client).find((e) => e.type === "user-prompt")
      );
      const promptEvents = receivedEvents(client).filter(
        (e) => e.type === "user-prompt"
      );
      expect(promptEvents.length).toBe(1);

      client.ws.close();
      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "WS upgrade with a disallowed Origin is refused (CSWSH)",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-origin-host",
      { stationKey: "acproute-origin" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      const { closeCode } = await new Promise<{ closeCode: number }>((resolve) => {
        const ws = new WebSocket(
          `ws://localhost:${server.port}/api/acp/sessions/${row.id}/ws`,
          {
            headers: {
              "X-Test-User-Id": TEST_USER,
              Origin: "https://evil.example",
            },
          } as RequestInit & { headers: Record<string, string> }
        );
        ws.onclose = (e) => resolve({ closeCode: e.code });
        ws.onerror = () => resolve({ closeCode: 1006 });
      });
      expect([1008, 1006, 1000, 1011].includes(closeCode)).toBe(true);

      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "WS auth: anonymous and wrong-user upgrades are closed; invalid client message → error event, socket stays open",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-auth-host",
      { stationKey: "acproute-auth" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      // Anonymous → closed.
      const anon = connectClientWs(server.port!, row.id);
      await anon.opened;
      const anonClose = await pollUntil(() => anon.getCloseCode());
      expect([1008, 1006, 1000, 1011].includes(anonClose)).toBe(true);

      // Wrong user → closed (session not owned).
      const wrong = connectClientWs(server.port!, row.id, OTHER_USER);
      await wrong.opened;
      const wrongClose = await pollUntil(() => wrong.getCloseCode());
      expect([1008, 1006, 1000, 1011].includes(wrongClose)).toBe(true);

      // Invalid message → error EVENT, not a close.
      const client = connectClientWs(server.port!, row.id, TEST_USER);
      await client.opened;
      client.ws.send("not json at all");
      await pollUntil(() =>
        receivedEvents(client).find((e) => e.type === "error")
      );
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: "nope" }));
      await pollUntil(
        () => receivedEvents(client).filter((e) => e.type === "error").length >= 2
      );
      expect(client.getCloseCode()).toBeNull(); // still open

      // The socket still works: a valid subscribe replays.
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      await pollUntil(() => client.msgs.find((m) => m.t === "replay-done"));

      client.ws.close();
      await endSession(TEST_USER, row.id, "test done");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "DELETE /api/acp/sessions/:id ends the session: 204 + row ended; 401 anonymous; 404 foreign session",
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-del-host",
      { stationKey: "acproute-del" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      // 401 anonymous (no auth header).
      const anon = await fetch(`${baseUrl}/api/acp/sessions/${row.id}`, {
        method: "DELETE",
      });
      expect(anon.status).toBe(401);

      // 404 foreign session — and it must NOT end the session.
      const foreign = await fetch(`${baseUrl}/api/acp/sessions/${row.id}`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": OTHER_USER },
      });
      expect(foreign.status).toBe(404);
      expect((await getSession(TEST_USER, row.id))?.status).toBe("idle");

      // 404 unknown session id.
      const unknown = await fetch(`${baseUrl}/api/acp/sessions/acps_nope`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(unknown.status).toBe(404);

      // Happy path: 204, row ended.
      const ended = await fetch(`${baseUrl}/api/acp/sessions/${row.id}`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(ended.status).toBe(204);
      const after = await getSession(TEST_USER, row.id);
      expect(after?.status).toBe("ended");
      expect(after?.endedReason).toBe("Ended from the console.");

      // Station released: a fresh session starts (no 409 lock).
      const again = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(again.status).toBe(201);
      const row2 = (await again.json()) as AcpSessionRow;
      await endSession(TEST_USER, row2.id, "test done");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  'attached WS client receives {t:"bye"} when the session is ended over REST',
  async () => {
    const { server, fake, station, baseUrl } = await setupRig(
      "acproute-delbye-host",
      { stationKey: "acproute-delbye" }
    );
    try {
      const created = await createSessionReq(baseUrl, station.id, { mode: "ask" });
      expect(created.status).toBe(201);
      const row = (await created.json()) as AcpSessionRow;

      const client = connectClientWs(server.port!, row.id, TEST_USER);
      await client.opened;
      client.ws.send(JSON.stringify({ t: "subscribe", sinceSeq: 0 }));
      await pollUntil(() => client.msgs.find((m) => m.t === "replay-done"));

      const res = await fetch(`${baseUrl}/api/acp/sessions/${row.id}`, {
        method: "DELETE",
        headers: { "X-Test-User-Id": TEST_USER },
      });
      expect(res.status).toBe(204);

      // The service fan-out delivers the state-ended event, then the bye.
      await pollUntil(() =>
        receivedEvents(client).find(
          (e) =>
            e.type === "state" &&
            (e.payload as { status?: string }).status === "ended"
        )
      );
      const bye = await pollUntil(() => client.msgs.find((m) => m.t === "bye"));
      expect(bye.reason).toBe("Ended from the console.");
      await pollUntil(() => client.getCloseCode() !== null);

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);
