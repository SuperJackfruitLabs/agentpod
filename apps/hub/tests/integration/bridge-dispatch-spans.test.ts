/**
 * One claimed run is one trace (superwitness spec §4.1): a `dispatch` root, the standard
 * agent spans under it, and every board call inside it carrying its traceparent. Content
 * planted in the card and in the harness's tool calls appears in no span.
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AcpEvent } from "@agentpod/contract";
import { ROOT_CONTEXT, context } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../../src/db/drizzle";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { runOnce, type AcpPort } from "../../src/services/bridge/dispatch";
import { SuperpipelineClient } from "../../src/services/bridge/superpipeline";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { useTestTelemetry } from "../helpers/telemetry";

const t = useTestTelemetry();

const MARKER = "CANARY-MARKER-d15p47";
const STATION_ID = "bridge-spans-station";
const SESSION_ID = "acps_55555555-6666-4777-8888-999999999999";
const USER_ID = "bridge-spans-user";
const BOARD_ID = "brd_5a5a5a5a5a5a5a5a";
const CARD_ID = "crd_6b6b6b6b6b6b6b6b";
const RUN_ID = "run_7c7c7c7c7c7c7c7c";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;

type Call = { path: string; headers: Record<string, string> };

function board() {
  const calls: Call[] = [];
  const client = new SuperpipelineClient({
    baseUrl: "https://board.test",
    boardId: BOARD_ID,
    token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      calls.push({ path, headers: { ...init.headers } });
      const body = path.endsWith("/claims")
        ? { claimed: true, runId: RUN_ID, leaseEpoch: 1, card: { id: CARD_ID, title: `Fix ${MARKER}`, attemptCount: 1 }, stage: { key: "work", name: "Work" }, handoff: null }
        : path.endsWith(`/runs/${RUN_ID}`)
          ? {
              run: { runId: RUN_ID, cardId: CARD_ID, stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
              card: { id: CARD_ID, title: `Fix ${MARKER}`, spec: `Do ${MARKER}`, currentStageKey: "work", state: "working", attemptCount: 1 },
              stage: { key: "work", name: "Work" }, handoff: null, references: [],
            }
          : { ok: true };
      return { status: 200, ok: true, json: async () => body };
    },
  });
  return { calls, client };
}

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: SESSION_ID, seq: ++seq, type, payload, createdAt: new Date().toISOString(),
});

function acp(script: () => AcpEvent[]): AcpPort {
  const subs = new Set<(e: AcpEvent) => void>();
  return {
    stationReady: async () => ({ ready: true }),
    createSession: async () => ({ id: SESSION_ID }),
    promptSession: async () => {
      queueMicrotask(() => { for (const e of script()) subs.forEach((fn) => fn(e)); });
    },
    subscribe: (_s, fn) => { subs.add(fn); return () => subs.delete(fn); },
    endSession: async () => {},
    answerPermission: async () => {},
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
  const now = new Date();
  await db.insert(acpSessions).values({
    tenantId: BOOTSTRAP_TENANT_ID, id: SESSION_ID, stationId: STATION_ID, userId: USER_ID,
    mode: "full-auto", status: "idle", lastSeq: 0, createdAt: now, lastEventAt: now,
  });
});

afterAll(async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION_ID}`;
});

test("a claimed run is one trace: dispatch > attempt > turn > tool_call, with no content", async () => {
  const b = board();
  const result = await runOnce({
    client: b.client,
    acp: acp(() => [
      ev("agent-update", { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "pending", title: `run ${MARKER}`, rawInput: { cmd: MARKER } }),
      ev("agent-update", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: MARKER }),
      ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `done ${MARKER}` } }),
      ev("state", { status: "idle" }),
    ]),
    agent: { key: "spans", boardId: BOARD_ID, token: TOKEN, stationId: STATION_ID, hubUserId: USER_ID, mode: "full-auto" },
    tenantId: BOOTSTRAP_TENANT_ID,
    source: "superpipeline",
    heartbeatMs: 60_000,
    turnTimeoutMs: 5_000,
  });
  expect(result.status).toBe("reported");

  const [row] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION_ID));
  const [dispatch] = t.named("dispatch");
  const [attempt] = t.named("attempt");
  const [turn] = t.named("turn");
  const [tool] = t.named("tool_call");

  expect(dispatch!.parentSpanContext).toBeUndefined();
  expect(dispatch!.attributes).toMatchObject({
    "run.id": RUN_ID, "board.id": BOARD_ID, "card.id": CARD_ID, "external.source": "superpipeline",
    "station.id": STATION_ID, "dispatch.status": "reported", "attempt.id": row!.id,
  });

  expect(attempt!.parentSpanContext?.spanId).toBe(dispatch!.spanContext().spanId);
  expect(attempt!.attributes).toMatchObject({
    "attempt.id": row!.id, "station.id": STATION_ID, "run.id": RUN_ID,
    "acp.session_id": SESSION_ID, "acp.seq_from": row!.startSeq, "attempt.state": "completed",
  });
  expect(String(attempt!.attributes["fingerprint.digest"])).toMatch(/^(sha256:[0-9a-f]{64}|unknown)$/);
  expect(typeof attempt!.attributes["harness.name"]).toBe("string");

  expect(turn!.parentSpanContext?.spanId).toBe(attempt!.spanContext().spanId);
  expect(tool!.parentSpanContext?.spanId).toBe(turn!.spanContext().spanId);
  expect(tool!.attributes).toMatchObject({ "tool.kind": "execute", "tool.status": "completed" });

  // The claim precedes the trace; every board call after it carries it.
  expect(b.calls[0]!.path.endsWith("/claims")).toBe(true);
  expect(b.calls[0]!.headers.traceparent).toBeUndefined();
  const traced = b.calls.slice(1);
  expect(traced.length).toBeGreaterThan(0);
  for (const c of traced) expect(c.headers.traceparent?.split("-")[1]).toBe(dispatch!.spanContext().traceId);

  const dump = JSON.stringify(t.spans().map((s) => [s.name, s.attributes, s.events, s.status, s.links]));
  expect(dump).not.toContain(MARKER);
});

test("events delivered outside the dispatch context still post board calls inside the trace", async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION_ID}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION_ID}`;
  const b = board();
  const subs = new Set<(e: AcpEvent) => void>();
  // Like the broker's WebSocket handler: the callback is fired from a timer started in the
  // root context, never from inside the dispatch span.
  const port: AcpPort = {
    stationReady: async () => ({ ready: true }),
    createSession: async () => ({ id: SESSION_ID }),
    promptSession: async () => {
      context.with(ROOT_CONTEXT, () => {
        setTimeout(() => {
          for (const e of [
            ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } }),
            ev("state", { status: "idle" }),
          ]) subs.forEach((fn) => fn(e));
        }, 5);
      });
    },
    subscribe: (_s, fn) => { subs.add(fn); return () => subs.delete(fn); },
    endSession: async () => {},
    answerPermission: async () => {},
  };
  const result = await runOnce({
    client: b.client,
    acp: port,
    agent: { key: "spans", boardId: BOARD_ID, token: TOKEN, stationId: STATION_ID, hubUserId: USER_ID, mode: "full-auto" },
    tenantId: BOOTSTRAP_TENANT_ID,
    source: "superpipeline",
    heartbeatMs: 60_000,
    turnTimeoutMs: 5_000,
  });
  expect(result.status).toBe("reported");
  const dispatch = t.named("dispatch").at(-1)!;
  const activities = b.calls.filter((c) => c.path.endsWith("/activity") || c.path.includes("activit"));
  expect(activities.length).toBeGreaterThan(0);
  for (const c of activities) expect(c.headers.traceparent?.split("-")[1]).toBe(dispatch.spanContext().traceId);
});
