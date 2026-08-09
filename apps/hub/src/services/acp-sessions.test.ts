/**
 * Service Test: ACP session service (hub-owned sessions over the ACP wire)
 *
 * Verifies src/services/acp-sessions.ts against a fake node speaking scripted
 * ACP (tests/helpers/acp-fake-node.ts):
 *
 *   1. createSession → row idle + state event persisted; single live session
 *      per station; capability/ownership/online gates; open-failure marks the
 *      row ended with an error event.
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
 *  10. reconcileOnBoot marks stale rows ended and best-effort closes orphans.
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
  _setOfflineGraceMsForTest,
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

async function pollForEvent(
  sessionId: string,
  match: (e: { type: string; payload: unknown }) => boolean,
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

const stateWith = (status: string) => (e: { type: string; payload: unknown }) =>
  e.type === "state" && (e.payload as { status?: string }).status === status;

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "createSession: row idle + state event; duplicate refused; endSession closes wire (node sees acp.close) + row ended + event",
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

      // Single live session per station.
      await expect(
        createSession({ stationId: station.id, userId: TEST_USER, mode: "ask" })
      ).rejects.toThrow("An active session already exists for this agent.");

      // getSession / listSessions surface the row.
      const fetched = await getSession(TEST_USER, row.id);
      expect(fetched?.id).toBe(row.id);
      const listed = await listSessions(TEST_USER, station.id);
      expect(listed.map((s) => s.id)).toContain(row.id);

      // endSession → node sees acp.close, row ended, state ended event.
      await endSession(TEST_USER, row.id, "user closed");
      const closeReq = await pollUntil(() =>
        parsedNodeMsgs(fake.nodeMsgs).find(
          (m) => m.type === "req" && (m as { verb?: string }).verb === "acp.close"
        )
      );
      expect((closeReq as { params: { sessionId: string } }).params.sessionId).toBe(
        "acp-proc-1"
      );

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
        (e) => stateWith("idle")(e) && (e as { seq: number }).seq > 1,
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
  "concurrent createSession for the same station: exactly one wins, the other gets the active-session error",
  async () => {
    const { server, fake, station } = await setupRig("acpsess-race-host", {
      stationKey: "acp-race-station",
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

      for (const id of [staleId, orphanId]) {
        const s = await getSession(TEST_USER, id);
        expect(s?.status).toBe("ended");
        expect(s?.endedReason).toBe("hub restarted");
      }
      // State event appended after the existing seq.
      const staleEvts = await eventsFor(staleId);
      expect(staleEvts.at(-1)!.type).toBe("state");
      expect((staleEvts.at(-1)!.payload as { status: string }).status).toBe("ended");
      expect(staleEvts.at(-1)!.seq).toBe(2);

      // Online node got a best-effort acp.close for the orphaned process id.
      const closeReq = await pollUntil(() =>
        parsedNodeMsgs(fake.nodeMsgs).find(
          (m) =>
            m.type === "req" &&
            (m as { verb?: string }).verb === "acp.close" &&
            (m as { params?: { sessionId?: string } }).params?.sessionId ===
              "acp-proc-stale-42"
        )
      );
      expect(closeReq).toBeTruthy();

      // Boot-time close clears the marker (once-only); the station-less
      // orphan keeps its marker (transcript row survives, nothing to close).
      await pollUntil(async () => {
        const r = await db
          .select()
          .from(acpSessions)
          .where(eq(acpSessions.id, staleId));
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
