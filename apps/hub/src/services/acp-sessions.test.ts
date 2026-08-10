/**
 * Service Test: ACP session service (hub-owned sessions over the ACP wire)
 *
 * Verifies src/services/acp-sessions.ts against a fake node speaking scripted
 * ACP (tests/helpers/acp-fake-node.ts):
 *
 *   1. createSession → row idle + state event persisted;
 *      capability/ownership/online gates; open-failure marks the row ended
 *      with an error event.
 *   2. promptSession → user-prompt / state working / agent-update / state idle
 *      ordering by seq; audit row (chars only, never text); subscribe fan-out.
 *   3. ask mode parks the permission (status waiting); answerPermission
 *      resolves it and restores working; events persisted.
 *   4. full-auto auto-answers with the first allow option (auto flag).
 *   5. accept-edits auto-allows edit toolCalls, parks the rest; setMode flips
 *      enforcement mid-session.
 *   6. cancelTurn sends session/cancel; prompt resolves cancelled → idle.
 *   7. wrong-user access → null / empty / throws.
 *   8. endSession closes the wire (node sees acp.close) + row ended + event.
 *   9. node offline mid-session → waiting + grace end.
 *  10. reconcileOnBoot marks stale rows ended and best-effort closes orphans,
 *      each row's OWN node_session_id, never one a live session holds.
 *  11. Slice 4b: several live sessions per station — distinct instances and
 *      node processes, independent transcripts, independent teardown; a node
 *      that doesn't echo the instance keeps the one-at-a-time behaviour.
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
import { asc, eq } from "drizzle-orm";
import type { AcpEvent, DetectedStation } from "@agentpod/contract";

// src/ imports — DB URL is already set above
import { db, rawSql } from "../db/drizzle";
import { acpSessions, acpEvents } from "../db/schema/acp";
import { createTestUser } from "../../tests/helpers/database";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import {
  connectFakeAcpNode,
  parsedNodeMsgs,
  pollUntil,
  type FakeAcpNodeOpts,
} from "../../tests/helpers/acp-fake-node";
import { mintEnrollmentToken, enrollNode } from "./enrollment";
import { adoptStations } from "./station-registry";
import { gatewayRoutes } from "../routes/gateway";
import { websocket } from "../ws";
import {
  createSession,
  listSessions,
  getSession,
  promptSession,
  cancelTurn,
  answerPermission,
  setMode,
  endSession,
  subscribe,
  reconcileOnBoot,
  closeOrphanedProcesses,
  _setOfflineGraceMsForTest,
  _setOpenDbTimeoutMsForTest,
  _setHandshakeTimeoutMsForTest,
} from "./acp-sessions";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-acpsess-001";
const OTHER_USER = "test-user-acpsess-002";

// ─── Minimal test app ─────────────────────────────────────────────────────────

const testApp = new Hono().route("/public/nodes", gatewayRoutes);

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "acpsess-test@example.com",
    name: "ACP Session Test User",
  });
  await createTestUser({
    id: OTHER_USER,
    email: "acpsess-other@example.com",
    name: "ACP Session Other User",
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

/** Boot a gateway server + fake ACP node + adopted station for TEST_USER. */
async function setupRig(hostname: string, opts: FakeAcpNodeOpts = {}) {
  const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
  const { nodeId, nodeSecret } = await enrollTestNode(hostname);
  const fake = await connectFakeAcpNode(server.port!, nodeId, nodeSecret, opts);
  const stationKey = opts.stationKey ?? "acp-sess-station";
  const detected: DetectedStation[] = [
    {
      key: stationKey,
      harness: "opencode",
      kind: "leaf",
      displayName: "ACP Session Test",
      parentKey: null,
      workspacePath: opts.workspacePath ?? "/workspace/acptest",
      capabilities: ["health", "acp"],
      matrixId: null,
      adopted: false,
    },
  ];
  const [station] = await adoptStations(TEST_USER, nodeId, [stationKey], detected);
  if (!station) throw new Error("station adoption failed");
  return { server, nodeId, fake, station };
}

async function eventsFor(sessionId: string) {
  return db
    .select()
    .from(acpEvents)
    .where(eq(acpEvents.sessionId, sessionId))
    .orderBy(asc(acpEvents.seq));
}

/** The shape both persisted rows and fanned-out events share. */
type EventLike = { seq: number; type: string; payload?: unknown };

async function pollForEvent(
  sessionId: string,
  match: (e: EventLike) => boolean,
  timeoutMs = 8000
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evts = await eventsFor(sessionId);
    const hit = evts.find(match);
    if (hit) return { hit, all: evts };
    if (Date.now() > deadline) {
      throw new Error(
        `event not found; have: ${JSON.stringify(evts.map((e) => [e.seq, e.type, e.payload]))}`
      );
    }
    await new Promise((r) => setTimeout(r, 40));
  }
}

const stateWith =
  (status: string) => (e: { type: string; payload?: unknown }) =>
    e.type === "state" && (e.payload as { status?: string }).status === status;

/** The node process id recorded on a session row. */
async function nodeSessionIdOf(sessionId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(acpSessions)
    .where(eq(acpSessions.id, sessionId));
  return rows[0]?.nodeSessionId ?? null;
}

/** acp.open requests the node received, in order. */
function opensSeenBy(fake: { nodeMsgs: string[] }) {
  return parsedNodeMsgs(fake.nodeMsgs).filter(
    (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.open"
  ) as Array<{ params?: { instance?: string; key?: string } }>;
}

/** acp.close requests the node received, in order of sessionId. */
function closesSeenBy(fake: { nodeMsgs: string[] }): string[] {
  return parsedNodeMsgs(fake.nodeMsgs)
    .filter(
      (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
    )
    .map(
      (m) => (m as { params?: { sessionId?: string } }).params?.sessionId ?? ""
    );
}

const promptTexts = (evts: Array<{ type: string; payload: unknown }>) =>
  evts
    .filter((e) => e.type === "user-prompt")
    .map((e) => (e.payload as { text: string }).text);

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "createSession: row idle + state event; endSession closes its own wire (node sees acp.close) + row ended + event",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-create-host");
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });

      expect(row.stationId).toBe(station.id);
      expect(row.userId).toBe(TEST_USER);
      expect(row.mode).toBe("ask");
      expect(row.status).toBe("idle");
      expect(row.endedReason).toBeNull();

      // state event {status:"idle"} persisted with seq 1.
      const evts = await eventsFor(row.id);
      expect(evts).toHaveLength(1);
      expect(evts[0]!.seq).toBe(1);
      expect(evts[0]!.type).toBe("state");
      expect((evts[0]!.payload as { status: string }).status).toBe("idle");

      // A second live session is allowed on a node that echoes the instance
      // (independence is covered by the multi-session test below).
      const sibling = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      expect(sibling.id).not.toBe(row.id);
      expect(sibling.status).toBe("idle");
      await endSession(TEST_USER, sibling.id, "cleanup");

      // getSession / listSessions surface the row.
      const fetched = await getSession(TEST_USER, row.id);
      expect(fetched?.id).toBe(row.id);
      const listed = await listSessions(TEST_USER, station.id);
      expect(listed.map((s) => s.id)).toContain(row.id);

      // endSession → node sees acp.close for THIS session's process id, row
      // ended, state ended event.
      await endSession(TEST_USER, row.id, "user closed");
      const closeReq = await pollUntil(() =>
        parsedNodeMsgs(fake.nodeMsgs).find(
          (m) =>
            m.type === "req" &&
            (m as { verb?: string }).verb === "acp.close" &&
            (m as { params?: { sessionId?: string } }).params?.sessionId ===
              "acp-proc-1"
        )
      );
      expect(closeReq).toBeTruthy();

      const ended = await getSession(TEST_USER, row.id);
      expect(ended?.status).toBe("ended");
      expect(ended?.endedReason).toBe("user closed");
      await pollForEvent(row.id, stateWith("ended"));

      // A new session can start once the previous one ended.
      const row2 = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });
      expect(row2.status).toBe("idle");
      await endSession(TEST_USER, row2.id, "cleanup");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "createSession gates: missing station, missing acp capability, offline node, open failure marks row ended + error event",
  async () => {
    const { server, nodeId, fake, station } = await setupRig(
      "acpsess-gates-host",
      { stationKey: "acp-gates-station", failOpen: "harness not found" }
    );
    try {
      // Unknown station.
      await expect(
        createSession({ stationId: "station_nope", userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow();

      // Wrong user (not the owner).
      await expect(
        createSession({ stationId: station.id, userId: OTHER_USER, mode: "ask" })
      ).rejects.toThrow();

      // Station without the acp capability.
      const [noAcp] = await adoptStations(TEST_USER, nodeId, ["no-acp-station"], [
        {
          key: "no-acp-station",
          harness: "hermes",
          kind: "leaf",
          displayName: "No ACP",
          parentKey: null,
          workspacePath: null,
          capabilities: ["health"],
          matrixId: null,
          adopted: false,
        },
      ]);
      await expect(
        createSession({ stationId: noAcp!.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow();

      // acp.open failure → throws AND leaves the row ended with an error event.
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow();
      const rows = await listSessions(TEST_USER, station.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.status).toBe("ended");
      expect(rows[0]!.endedReason).toContain("Couldn't start the agent process");
      const evts = await eventsFor(rows[0]!.id);
      expect(evts.some((e) => e.type === "error")).toBe(true);

      // The failure exit cleaned the live maps: a retry hits the open failure
      // again — NOT the single-session guard (which would wedge the station).
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("Couldn't start the agent process");

      // Offline node.
      fake.close();
      await new Promise((r) => setTimeout(r, 200));
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "handshake timeout: an agent that spawns but never responds → createSession rejects, wire closed, station not wedged (maps drained)",
  async () => {
    _setHandshakeTimeoutMsForTest(300);
    const { server, fake, station } = await setupRig("acpsess-hshake-host", {
      stationKey: "acp-hshake-station",
      hangHandshake: "initialize",
    });
    try {
      // Wedged on initialize → deadline fires with the standard copy.
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("Couldn't start the agent process");

      // The spawned process is torn down: node saw the best-effort acp.close.
      await pollUntil(() =>
        parsedNodeMsgs(fake.nodeMsgs).find(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
        )
      );

      // Row ended with the timeout copy + error event.
      const rows = await listSessions(TEST_USER, station.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("ended");
      expect(rows[0]!.endedReason).toContain("handshake timed out");
      const evts = await eventsFor(rows[0]!.id);
      expect(evts.some((e) => e.type === "error")).toBe(true);

      // Wedged on session/new times out the same way.
      fake.opts.hangHandshake = "session/new";
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("Couldn't start the agent process");

      // Maps drained: with a healthy agent the station accepts a fresh
      // session — no "active session already exists" 409-lock.
      fake.opts.hangHandshake = undefined;
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      expect(row.status).toBe("idle");

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      _setHandshakeTimeoutMsForTest(30_000);
      server.stop(true);
    }
  },
  20_000
);

test(
  "promptSession: user-prompt → working → agent-update → idle ordering by seq; audit row records chars, never text; subscribe fan-out",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-prompt-host", {
      stationKey: "acp-prompt-station",
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });

      const liveEvents: AcpEvent[] = [];
      const unsub = subscribe(row.id, (e) => liveEvents.push(e));

      await promptSession(TEST_USER, row.id, "please do the thing");

      // Turn ends back at idle (skip seq 1 = the create-time idle event).
      const { all } = await pollForEvent(
        row.id,
        (e) => stateWith("idle")(e) && e.seq > 1,
        8000
      );

      // Ordering by seq: user-prompt < state working < agent-update < final idle.
      const types = all.map((e) => e.type);
      const promptIdx = types.indexOf("user-prompt");
      const workingIdx = all.findIndex(stateWith("working"));
      const updateIdx = types.indexOf("agent-update");
      const idleIdx = all.findIndex(
        (e, i) => i > promptIdx && stateWith("idle")(e)
      );
      expect(promptIdx).toBeGreaterThan(-1);
      expect(workingIdx).toBeGreaterThan(promptIdx);
      expect(updateIdx).toBeGreaterThan(workingIdx);
      expect(idleIdx).toBeGreaterThan(updateIdx);

      // seqs strictly increasing and gapless from 1.
      expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));

      // user-prompt payload carries the text (transcript, not audit).
      expect(
        (all[promptIdx]!.payload as { text: string }).text
      ).toBe("please do the thing");

      // agent-update carries the raw SDK update payload.
      const update = all[updateIdx]!.payload as {
        sessionUpdate: string;
        content: { type: string; text: string };
      };
      expect(update.sessionUpdate).toBe("agent_message_chunk");
      expect(update.content.text).toBe("Working on it");

      // Session row is idle again.
      const after = await getSession(TEST_USER, row.id);
      expect(after?.status).toBe("idle");

      // Subscribe fan-out delivered the same events (at least prompt→idle).
      await pollUntil(() => liveEvents.some((e) => stateWith("idle")(e)));
      expect(liveEvents.some((e) => e.type === "user-prompt")).toBe(true);
      expect(liveEvents.some((e) => e.type === "agent-update")).toBe(true);
      unsub();

      // Audit row: verb acp.prompt, chars only — never the prompt text.
      const audits = await rawSql`
        SELECT verb, params_summary FROM station_audit
        WHERE user_id = ${TEST_USER} AND verb = 'acp.prompt'`;
      expect(audits.length).toBeGreaterThan(0);
      const summary = audits[0]!.params_summary as Record<string, unknown>;
      expect(summary.chars).toBe("please do the thing".length);
      expect(JSON.stringify(summary)).not.toContain("please do the thing");

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "ask mode: permission parks (status waiting), answerPermission resolves it, events persisted, agent sees selected outcome",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-ask-host", {
      stationKey: "acp-ask-station",
      permission: { toolKind: "execute" },
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });

      await promptSession(TEST_USER, row.id, "run a command");

      // permission-request persisted; session parks at waiting.
      const { hit: permReq } = await pollForEvent(
        row.id,
        (e) => e.type === "permission-request"
      );
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "waiting";
      });
      const reqPayload = permReq.payload as {
        toolCall: { toolCallId: string; kind: string };
        options: Array<{ optionId: string }>;
      };
      expect(reqPayload.toolCall.kind).toBe("execute");
      expect(reqPayload.options.map((o) => o.optionId)).toContain("allow");

      // The agent has NOT yet received an outcome.
      expect(fake.permissionOutcomes).toHaveLength(0);

      // Answer → agent unblocks, turn completes, back to idle.
      const requestSeq = (permReq as { seq: number }).seq;
      await answerPermission(TEST_USER, row.id, requestSeq, "allow");

      await pollForEvent(row.id, (e) => e.type === "permission-answer");
      await pollUntil(() => fake.permissionOutcomes.length === 1);
      expect(fake.permissionOutcomes[0]).toEqual({
        outcome: "selected",
        optionId: "allow",
      });

      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });
      const all = await eventsFor(row.id);
      const answer = all.find((e) => e.type === "permission-answer")!;
      expect((answer.payload as { requestSeq: number }).requestSeq).toBe(requestSeq);
      expect((answer.payload as { optionId: string }).optionId).toBe("allow");
      expect((answer.payload as { auto?: boolean }).auto).toBeFalsy();

      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      // Answering again → no pending request.
      await expect(
        answerPermission(TEST_USER, row.id, requestSeq, "allow")
      ).rejects.toThrow();

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "full-auto: auto-answers the first allow option; request+answer events carry the auto flag",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-auto-host", {
      stationKey: "acp-auto-station",
      permission: { toolKind: "execute" },
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });

      await promptSession(TEST_USER, row.id, "just do it");

      await pollUntil(() => fake.permissionOutcomes.length === 1);
      expect(fake.permissionOutcomes[0]).toEqual({
        outcome: "selected",
        optionId: "allow",
      });

      const { hit: answer, all } = await pollForEvent(
        row.id,
        (e) => e.type === "permission-answer"
      );
      expect((answer.payload as { auto?: boolean }).auto).toBe(true);
      expect((answer.payload as { optionId: string }).optionId).toBe("allow");
      expect(all.some((e) => e.type === "permission-request")).toBe(true);

      // Never parked: no waiting state event.
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });
      const finalEvents = await eventsFor(row.id);
      expect(finalEvents.some(stateWith("waiting"))).toBe(false);

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "accept-edits: edit toolCalls auto-allowed, others park; setMode flips enforcement mid-session",
  async () => {
    const permission = { toolKind: "edit" };
    const { server, fake, station } = await setupRig("acpsess-edits-host", {
      stationKey: "acp-edits-station",
      permission,
    });
    try {
      // Start in ask, then flip to accept-edits via setMode.
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      await setMode(TEST_USER, row.id, "accept-edits");
      const flipped = await getSession(TEST_USER, row.id);
      expect(flipped?.mode).toBe("accept-edits");

      // Edit toolCall → auto-allowed, no parking.
      await promptSession(TEST_USER, row.id, "edit the file");
      await pollUntil(() => fake.permissionOutcomes.length === 1);
      expect(fake.permissionOutcomes[0]).toEqual({
        outcome: "selected",
        optionId: "allow",
      });
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      // Non-edit toolCall → parks like ask.
      permission.toolKind = "execute";
      await promptSession(TEST_USER, row.id, "now run a command");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "waiting";
      });
      const evts = await eventsFor(row.id);
      const parked = evts.filter((e) => e.type === "permission-request").at(-1)!;
      await answerPermission(TEST_USER, row.id, parked.seq, "allow");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "cancelTurn: agent receives session/cancel, hanging prompt resolves cancelled, status back to idle; prompt while working refused",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-cancel-host", {
      stationKey: "acp-cancel-station",
      hangPrompt: true,
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });

      await promptSession(TEST_USER, row.id, "long task");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "working";
      });

      // A second prompt while working is refused.
      await expect(
        promptSession(TEST_USER, row.id, "another")
      ).rejects.toThrow();

      await cancelTurn(TEST_USER, row.id);

      // Agent saw the cancel notification.
      await pollUntil(() =>
        fake.agentReceived.find((m) => m.method === "session/cancel")
      );

      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "wrong-user access: getSession null, listSessions empty, prompt/cancel/end/setMode throw",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-authz-host", {
      stationKey: "acp-authz-station",
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });

      expect(await getSession(OTHER_USER, row.id)).toBeNull();
      expect(await listSessions(OTHER_USER, station.id)).toEqual([]);
      await expect(promptSession(OTHER_USER, row.id, "hi")).rejects.toThrow();
      await expect(cancelTurn(OTHER_USER, row.id)).rejects.toThrow();
      await expect(setMode(OTHER_USER, row.id, "full-auto")).rejects.toThrow();
      await expect(endSession(OTHER_USER, row.id, "nope")).rejects.toThrow();

      // Still intact for the owner.
      const mine = await getSession(TEST_USER, row.id);
      expect(mine?.status).toBe("idle");

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "stale-turn epoch: a cancelled turn's late completion cannot clobber the next turn's status",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-epoch-host", {
      stationKey: "acp-epoch-station",
      hangPrompt: true,
      ignoreCancel: true, // prompts stay pending until releasePrompt()
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });

      // Turn #1 hangs; cancel it (the fake ignores the cancel, so the SDK
      // request for turn #1 stays pending).
      await promptSession(TEST_USER, row.id, "task one");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "working";
      });
      await cancelTurn(TEST_USER, row.id);
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      // Turn #2 starts.
      await promptSession(TEST_USER, row.id, "task two");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "working";
      });
      const before = (await eventsFor(row.id)).length;

      // NOW turn #1's late response arrives (oldest pending prompt).
      fake.releasePrompt("end_turn");
      await new Promise((r) => setTimeout(r, 300));

      // Status must stay working and no spurious state event may appear.
      const mid = await getSession(TEST_USER, row.id);
      expect(mid?.status).toBe("working");
      const after = await eventsFor(row.id);
      expect(after.length).toBe(before);

      // Turn #2's own completion still lands normally.
      fake.releasePrompt("end_turn");
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "idle";
      });

      await endSession(TEST_USER, row.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "concurrent createSession for the same station: a node that echoes instances hosts both; a legacy node lets exactly one win",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-race-host", {
      stationKey: "acp-race-station",
    });
    try {
      const results = await Promise.allSettled([
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" }),
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      const both = results.map(
        (r) => (r as PromiseFulfilledResult<{ id: string }>).value
      );
      expect(new Set(both.map((s) => s.id)).size).toBe(2);
      // Distinct agent processes on the node — never one shared process.
      const procIds = await Promise.all(
        both.map(async (s) => (await nodeSessionIdOf(s.id))!)
      );
      expect(new Set(procIds).size).toBe(2);

      for (const s of both) await endSession(TEST_USER, s.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "concurrent createSession against a legacy node: exactly one wins, the loser gets the active-session error",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-race-legacy-host", {
      stationKey: "acp-race-legacy-station",
      legacyOpen: true,
    });
    try {
      const results = await Promise.allSettled([
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" }),
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected");
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(String((lost[0] as PromiseRejectedResult).reason)).toContain(
        "An active session already exists for this agent."
      );

      // Only ONE process was ever opened: the loser never reached the node.
      expect(
        parsedNodeMsgs(fake.nodeMsgs).filter(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.open"
        )
      ).toHaveLength(1);

      const winner = (won[0] as PromiseFulfilledResult<{ id: string }>).value;
      await endSession(TEST_USER, winner.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "endSession mid-parked-ask: parked permission resolves with the cancelled outcome; permission-answer {cancelled:true} persisted",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-endpark-host", {
      stationKey: "acp-endpark-station",
      permission: { toolKind: "execute" },
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });

      await promptSession(TEST_USER, row.id, "risky operation");
      const { hit: permReq } = await pollForEvent(
        row.id,
        (e) => e.type === "permission-request"
      );
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "waiting";
      });

      await endSession(TEST_USER, row.id, "user closed mid-permission");

      // The agent received the SDK's cancelled outcome for the parked request.
      await pollUntil(() => fake.permissionOutcomes.length === 1);
      expect(fake.permissionOutcomes[0]).toEqual({ outcome: "cancelled" });

      // permission-answer {cancelled:true} persisted with the request's seq.
      const evts = await eventsFor(row.id);
      const answer = evts.find((e) => e.type === "permission-answer")!;
      expect((answer.payload as { cancelled?: boolean }).cancelled).toBe(true);
      expect((answer.payload as { requestSeq: number }).requestSeq).toBe(
        (permReq as { seq: number }).seq
      );

      const ended = await getSession(TEST_USER, row.id);
      expect(ended?.status).toBe("ended");
      expect(ended?.endedReason).toBe("user closed mid-permission");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "boot orphan cleanup: node offline at reconcile keeps the marker; the node's next connect triggers acp.close exactly once",
  async () => {
    const server = Bun.serve({ fetch: testApp.fetch, websocket, port: 0 });
    try {
      const { nodeId, nodeSecret } = await enrollTestNode("acpsess-orphan-host");
      // Adopt the station WITHOUT connecting the node (DB-only).
      const [station] = await adoptStations(TEST_USER, nodeId, ["acp-orphan-station"], [
        {
          key: "acp-orphan-station",
          harness: "opencode",
          kind: "leaf",
          displayName: "Orphan Station",
          parentKey: null,
          workspacePath: "/workspace/orphan",
          capabilities: ["health", "acp"],
          matrixId: null,
          adopted: false,
        },
      ]);
      const staleId = `acps_${crypto.randomUUID()}`;
      await db.insert(acpSessions).values({
        id: staleId,
        stationId: station!.id,
        userId: TEST_USER,
        mode: "ask",
        status: "working",
        endedReason: null,
        nodeSessionId: "acp-proc-orphan-9",
        createdAt: new Date(),
        lastEventAt: new Date(),
      });

      // Boot reconcile with the node offline: row ends, marker survives.
      await reconcileOnBoot();
      const afterBoot = await db
        .select()
        .from(acpSessions)
        .where(eq(acpSessions.id, staleId));
      expect(afterBoot[0]!.status).toBe("ended");
      expect(afterBoot[0]!.nodeSessionId).toBe("acp-proc-orphan-9");

      // Node connects → hook fires the best-effort acp.close…
      const fake = await connectFakeAcpNode(server.port!, nodeId, nodeSecret, {
        stationKey: "acp-orphan-station",
      });
      await pollUntil(() =>
        parsedNodeMsgs(fake.nodeMsgs).find(
          (m) =>
            m.type === "req" &&
            (m as { verb?: string }).verb === "acp.close" &&
            (m as { params?: { sessionId?: string } }).params?.sessionId ===
              "acp-proc-orphan-9"
        )
      );
      // …and clears the marker so it's once-only.
      await pollUntil(async () => {
        const r = await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.id, staleId));
        return r[0]?.nodeSessionId === null;
      });

      // Reconnect: no second acp.close for the already-cleared orphan.
      fake.close();
      await new Promise((r) => setTimeout(r, 200));
      const fake2 = await connectFakeAcpNode(server.port!, nodeId, nodeSecret, {
        stationKey: "acp-orphan-station",
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(
        parsedNodeMsgs(fake2.nodeMsgs).filter(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
        )
      ).toHaveLength(0);

      fake2.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

test(
  "node offline mid-session: status waiting with reason, then grace timer ends the session",
  async () => {
    _setOfflineGraceMsForTest(300);
    const { server, fake, station } = await setupRig("acpsess-offline-host", {
      stationKey: "acp-offline-station",
    });
    try {
      const row = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });

      // Node drops: wire ends without an exit frame.
      fake.close();

      const { hit: waiting } = await pollForEvent(row.id, stateWith("waiting"));
      expect((waiting.payload as { reason?: string }).reason).toBe("node offline");

      await pollUntil(async () => {
        const s = await getSession(TEST_USER, row.id);
        return s?.status === "ended";
      });
      const ended = await getSession(TEST_USER, row.id);
      expect(ended?.endedReason).toBe("Couldn't reach the node.");
      await pollForEvent(row.id, stateWith("ended"));

      await new Promise((r) => setTimeout(r, 100));
    } finally {
      _setOfflineGraceMsForTest(60_000);
      server.stop(true);
    }
  },
  20_000
);

test(
  "reconcileOnBoot: stale non-ended rows marked ended('hub restarted') with a state event; orphaned nodeSessionId best-effort closed on online nodes",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-boot-host", {
      stationKey: "acp-boot-station",
    });
    try {
      // A stale row as if the hub crashed mid-session.
      const staleId = `acps_${crypto.randomUUID()}`;
      await db.insert(acpSessions).values({
        id: staleId,
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
        status: "working",
        endedReason: null,
        nodeSessionId: "acp-proc-stale-42",
        createdAt: new Date(),
        lastEventAt: new Date(),
      });
      await db.insert(acpEvents).values({
        sessionId: staleId,
        seq: 1,
        type: "state",
        payload: { status: "idle" },
        createdAt: new Date(),
      });

      // A SECOND stale row on the SAME station with its own process id (two
      // concurrent sessions before the restart) — each must be closed by id.
      const staleId2 = `acps_${crypto.randomUUID()}`;
      await db.insert(acpSessions).values({
        id: staleId2,
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
        status: "idle",
        endedReason: null,
        nodeSessionId: "acp-proc-stale-43",
        createdAt: new Date(),
        lastEventAt: new Date(),
      });

      // A stale row whose station is gone (transcript survives; no close possible).
      const orphanId = `acps_${crypto.randomUUID()}`;
      await db.insert(acpSessions).values({
        id: orphanId,
        stationId: "station_deleted_long_ago",
        userId: TEST_USER,
        mode: "ask",
        status: "waiting",
        endedReason: null,
        nodeSessionId: "acp-proc-gone-7",
        createdAt: new Date(),
        lastEventAt: new Date(),
      });

      await reconcileOnBoot();

      for (const id of [staleId, staleId2, orphanId]) {
        const s = await getSession(TEST_USER, id);
        expect(s?.status).toBe("ended");
        expect(s?.endedReason).toBe("hub restarted");
      }
      // State event appended after the existing seq.
      const staleEvts = await eventsFor(staleId);
      expect(staleEvts.at(-1)!.type).toBe("state");
      expect((staleEvts.at(-1)!.payload as { status: string }).status).toBe("ended");
      expect(staleEvts.at(-1)!.seq).toBe(2);

      // Online node got a best-effort acp.close for EACH row's own process id.
      await pollUntil(() =>
        closesSeenBy(fake).includes("acp-proc-stale-42") &&
        closesSeenBy(fake).includes("acp-proc-stale-43")
      );

      // Boot-time close clears the marker (once-only); the station-less
      // orphan keeps its marker (transcript row survives, nothing to close).
      await pollUntil(async () => {
        const r = await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.id, staleId));
        return r[0]?.nodeSessionId === null;
      });
      await pollUntil(async () => {
        const r = await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.id, staleId2));
        return r[0]?.nodeSessionId === null;
      });
      const orphanRow = await db
        .select()
        .from(acpSessions)
        .where(eq(acpSessions.id, orphanId));
      expect(orphanRow[0]!.nodeSessionId).toBe("acp-proc-gone-7");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  20_000
);

// ─── Slice 4b: several live sessions per station ───────────────────────────────

test(
  "two concurrent sessions on one station: each acp.open carries its own instance, transcripts stream independently, ending one leaves the other live",
  async () => {
    // exitOnClose: ending one session really kills its agent process, so
    // "the sibling survives" is a claim about the code, not about the fake.
    const { server, fake, station } = await setupRig("acpsess-multi-host", {
      stationKey: "acp-multi-station",
      exitOnClose: true,
    });
    try {
      const a = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });
      const b = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });
      expect(a.id).not.toBe(b.id);
      expect(a.status).toBe("idle");
      expect(b.status).toBe("idle");

      // Each open carried the hub session id as its instance — two distinct ones.
      const opens = opensSeenBy(fake);
      expect(opens).toHaveLength(2);
      expect(opens.map((o) => o.params?.instance)).toEqual([a.id, b.id]);

      // …and the node spawned a distinct process per session, recorded per row.
      const procA = (await nodeSessionIdOf(a.id))!;
      const procB = (await nodeSessionIdOf(b.id))!;
      expect(procA).toBeTruthy();
      expect(procB).toBeTruthy();
      expect(procA).not.toBe(procB);
      expect(fake.processFor(a.id)!.sessionId).toBe(procA);
      expect(fake.processFor(b.id)!.sessionId).toBe(procB);

      // A prompt in A never appears in B's transcript.
      await promptSession(TEST_USER, a.id, "hello from A");
      await pollForEvent(
        a.id,
        (e) => stateWith("idle")(e) && e.seq > 1
      );
      const aEvents = await eventsFor(a.id);
      expect(promptTexts(aEvents)).toEqual(["hello from A"]);
      expect(aEvents.some((e) => e.type === "agent-update")).toBe(true);

      const bEvents = await eventsFor(b.id);
      expect(bEvents).toHaveLength(1); // only its own create-time idle state
      expect(promptTexts(bEvents)).toEqual([]);
      expect(bEvents.some((e) => e.type === "agent-update")).toBe(false);

      // B's own prompt runs on B's process and stays out of A's transcript.
      await promptSession(TEST_USER, b.id, "hello from B");
      await pollForEvent(
        b.id,
        (e) => stateWith("idle")(e) && e.seq > 1
      );
      const bAfter = await eventsFor(b.id);
      expect(promptTexts(bAfter)).toEqual(["hello from B"]);
      expect(bAfter.some((e) => e.type === "agent-update")).toBe(true);
      expect(promptTexts(await eventsFor(a.id))).toEqual(["hello from A"]);
      expect(
        fake
          .processFor(b.id)!
          .agentReceived.some((m) => m.method === "session/prompt")
      ).toBe(true);

      // Ending A closes A's process only; B stays live and usable.
      await endSession(TEST_USER, a.id, "done with A");
      await pollUntil(() => closesSeenBy(fake).includes(procA));
      expect(closesSeenBy(fake)).not.toContain(procB);
      expect((await getSession(TEST_USER, a.id))?.status).toBe("ended");
      expect((await getSession(TEST_USER, b.id))?.status).toBe("idle");

      await promptSession(TEST_USER, b.id, "still alive");
      await pollForEvent(
        b.id,
        (e) =>
          e.type === "user-prompt" &&
          (e.payload as { text: string }).text === "still alive"
      );
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, b.id);
        return s?.status === "idle";
      });
      expect(closesSeenBy(fake)).not.toContain(procB);

      await endSession(TEST_USER, b.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000
);

test(
  "legacy node (no instance echo): the second createSession is refused with the pinned error before any second open, leaving no stray row, live entry or wire",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-legacy-host", {
      stationKey: "acp-legacy-station",
      legacyOpen: true,
    });
    try {
      const a = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });
      expect(a.status).toBe("idle");

      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("An active session already exists for this agent.");

      // Refused BEFORE touching the node: no second acp.open, no leaked wire.
      expect(opensSeenBy(fake)).toHaveLength(1);
      // …and no stray session row for the refused attempt.
      const rows = await listSessions(TEST_USER, station.id);
      expect(rows.map((r) => r.id)).toEqual([a.id]);

      // The live session is untouched and still usable.
      await promptSession(TEST_USER, a.id, "still mine");
      await pollForEvent(
        a.id,
        (e) => stateWith("idle")(e) && e.seq > 1
      );
      expect(promptTexts(await eventsFor(a.id))).toEqual(["still mine"]);

      // Ending it releases the station — no 409 lock.
      await endSession(TEST_USER, a.id, "cleanup");
      const next = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      expect(next.status).toBe("idle");
      await endSession(TEST_USER, next.id, "cleanup");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000
);

test(
  "a node that stops echoing the instance mid-life: the post-open layer tears the new wire down and refuses, leaving no live entry",
  async () => {
    // exitOnClose: closing an agent process really kills it here, so the
    // teardown's effect on the session sharing that process is not hidden.
    const { server, fake, station } = await setupRig("acpsess-noecho-host", {
      stationKey: "acp-noecho-station",
      exitOnClose: true,
    });
    try {
      const a = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "full-auto",
      });
      expect(a.status).toBe("idle");

      // The node degrades: it still accepts acp.open but stops echoing, so the
      // process it hands back may be the one session A is already using. Only
      // the post-open layer can catch that.
      fake.opts.legacyOpen = true;
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("An active session already exists for this agent.");

      // The refused attempt did reach the node, and its row is ended with the
      // pinned reason + an error event (the standard failure exit).
      expect(opensSeenBy(fake)).toHaveLength(2);
      const rows = await listSessions(TEST_USER, station.id);
      const refused = rows.find((r) => r.id !== a.id)!;
      expect(refused.status).toBe("ended");
      expect(refused.endedReason).toBe(
        "An active session already exists for this agent."
      );
      const refusedEvents = await eventsFor(refused.id);
      expect(refusedEvents.some((e) => e.type === "error")).toBe(true);

      // KNOWN RESIDUAL HAZARD, pinned rather than hidden: the node handed back
      // A's process, so tearing the refused wire down closes it and takes A with
      // it. This costs one session instead of bleeding two conversations into one
      // process, and layer 1 keeps it unreachable for any node that never echoes
      // (only a node that echoed and then stopped can get here).
      await pollUntil(async () => {
        const s = await getSession(TEST_USER, a.id);
        return s?.status === "ended";
      });
      // …and it ended from the process exit, not from anything the hub decided.
      expect((await getSession(TEST_USER, a.id))?.endedReason).toBe("closed");

      // No live entry leaked either: a fresh session starts (the node still
      // can't echo, so one at a time).
      const next = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      expect(next.status).toBe("idle");
      await endSession(TEST_USER, next.id, "cleanup");

      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000
);

test(
  "a queued open re-reads the station: the node going offline while it waits is refused, not dialled",
  async () => {
    // The first open wedges on the handshake, so the second create sits in the
    // station's open queue long enough for the fleet to change under it.
    _setHandshakeTimeoutMsForTest(1500);
    const { server, fake, station } = await setupRig("acpsess-requeue-host", {
      stationKey: "acp-requeue-station",
      hangHandshake: "initialize",
    });
    try {
      // Settle both outcomes as values so neither can become an unhandled
      // rejection while the other is being asserted.
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => "resolved",
          (err) => String(err)
        );
      const first = outcome(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      );
      await new Promise((r) => setTimeout(r, 100));
      // Passes the fail-fast gates while the node is still online, then queues.
      const queued = outcome(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      );
      await new Promise((r) => setTimeout(r, 100));
      fake.close();

      // The wedged open fails (dropped connection or handshake deadline)…
      expect(await first).not.toBe("resolved");
      // …and the queued one re-read the station instead of dialling a node that
      // is no longer there.
      expect(await queued).toContain("Node is offline.");

      await new Promise((r) => setTimeout(r, 100));
    } finally {
      _setHandshakeTimeoutMsForTest(30_000);
      server.stop(true);
    }
  },
  30_000
);

test(
  "a stalled DB write inside the open phase rejects with the database copy and still drains the live map (no 409 lock on the station)",
  async () => {
    // The station's transcript table is locked for the duration, so the open
    // phase's idle state-event insert BLOCKS — a real stalled query, not a mock.
    _setHandshakeTimeoutMsForTest(2000);
    _setOpenDbTimeoutMsForTest(300);
    const { server, fake, station } = await setupRig("acpsess-dbstall-host", {
      stationKey: "acp-dbstall-station",
    });
    let releaseLock!: () => void;
    const lockHeld = new Promise<void>((r) => {
      releaseLock = r;
    });
    let signalLocked!: () => void;
    const locked = new Promise<void>((r) => {
      signalLocked = r;
    });
    // EXCLUSIVE conflicts with the INSERT's ROW EXCLUSIVE but not with reads.
    const lockTx = rawSql.begin(async (tx) => {
      await tx`LOCK TABLE acp_events IN EXCLUSIVE MODE`;
      signalLocked();
      await lockHeld;
    });
    try {
      await locked;

      const attempt = createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      }).then(
        () => "resolved",
        (err) => String(err)
      );
      // Long enough for the bounded DB step to trip while the table is locked.
      await new Promise((r) => setTimeout(r, 900));
      releaseLock();
      await lockTx;

      // The per-step DB deadline is what fired — not the open-phase backstop.
      expect(await attempt).toContain("the database didn't respond");

      // The failure exit still ran once the DB freed up: the row is ended and
      // nothing is left in the live map, so the station is NOT 409-locked.
      const rows = await listSessions(TEST_USER, station.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("ended");
      expect(rows[0]!.endedReason).toContain("the database didn't respond");

      const next = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      expect(next.status).toBe("idle");

      await endSession(TEST_USER, next.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      releaseLock();
      _setOpenDbTimeoutMsForTest(10_000);
      _setHandshakeTimeoutMsForTest(30_000);
      server.stop(true);
    }
  },
  30_000
);

test(
  "closeOrphanedProcesses: closes each ended row's own node session id, never one a live session is holding",
  async () => {
    const { server, nodeId, fake, station } = await setupRig(
      "acpsess-orphan-multi-host",
      { stationKey: "acp-orphan-multi-station" }
    );
    try {
      const live = await createSession({
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
      });
      const liveProc = (await nodeSessionIdOf(live.id))!;
      expect(liveProc).toBeTruthy();

      // Two orphan markers with their own process ids (two sessions that ended
      // while the node was away) …
      const orphanProcs = ["acp-proc-multi-a", "acp-proc-multi-b"];
      const orphanIds: string[] = [];
      for (const proc of orphanProcs) {
        const id = `acps_${crypto.randomUUID()}`;
        orphanIds.push(id);
        await db.insert(acpSessions).values({
          id,
          stationId: station.id,
          userId: TEST_USER,
          mode: "ask",
          status: "ended",
          endedReason: "node went away",
          nodeSessionId: proc,
          createdAt: new Date(),
          lastEventAt: new Date(),
        });
      }
      // … and a poisoned marker pointing at the process the LIVE session holds.
      const poisonedId = `acps_${crypto.randomUUID()}`;
      await db.insert(acpSessions).values({
        id: poisonedId,
        stationId: station.id,
        userId: TEST_USER,
        mode: "ask",
        status: "ended",
        endedReason: "node went away",
        nodeSessionId: liveProc,
        createdAt: new Date(),
        lastEventAt: new Date(),
      });

      await closeOrphanedProcesses(nodeId);

      // Each orphan closed by its own id, markers cleared.
      await pollUntil(() =>
        orphanProcs.every((proc) => closesSeenBy(fake).includes(proc))
      );
      for (const id of orphanIds) {
        const r = await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.id, id));
        expect(r[0]!.nodeSessionId).toBeNull();
      }

      // The live session's process was never closed and keeps its marker.
      expect(closesSeenBy(fake)).not.toContain(liveProc);
      const poisoned = await db
        .select()
        .from(acpSessions)
        .where(eq(acpSessions.id, poisonedId));
      expect(poisoned[0]!.nodeSessionId).toBe(liveProc);
      expect((await getSession(TEST_USER, live.id))?.status).toBe("idle");

      await endSession(TEST_USER, live.id, "cleanup");
      fake.close();
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      server.stop(true);
    }
  },
  30_000
);
