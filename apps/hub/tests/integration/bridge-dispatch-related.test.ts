/**
 * Related prior work in a claim, start to finish: a fake board, a fake ACP port, a fake
 * Superlibrary client, and the hub's own station and board-settings tables.
 *
 * The production-wiring tests inject neither `occupant` nor `relatedWork`: the principal comes
 * from the station row through `resolveStationOccupant`, the board switch from
 * `bridge_board_settings`, and the call through `superlibraryClient()`. That is the path a real
 * claim takes, and a dispatch that resolved no principal there would never show the section.
 *
 * DATABASE_URL must point at a pgvector test Postgres (root CLAUDE.md).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { AcpEvent, CardPromptRelated } from "@agentpod/contract";
import { and, eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { acpRuns, acpSessions } from "../../src/db/schema/acp";
import { bridgeBoardSettings } from "../../src/db/schema/bridge";
import { nodes } from "../../src/db/schema/nodes";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import type { BridgeAgentConfig } from "../../src/services/bridge/config";
import { runOnce, type AcpPort, type DispatchDeps } from "../../src/services/bridge/dispatch";
import { SuperpipelineClient } from "../../src/services/bridge/superpipeline";
import { setSuperlibraryClientForTests } from "../../src/services/superlibrary/client";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const TENANT = BOOTSTRAP_TENANT_ID;
const NODE = "node_bridge_related";
const STATION = "station_bridge_related";
const SESSION = "acps_00000000-0000-4000-8000-0000000000a1";
const BOARD = "brd_00000000000000b1";
const CARD = "card_00000000000000c1";
const RUN = "run_00000000000000d1";
const PRINCIPAL = "prn_000000000000000000a2";
const TOKEN = `spa_${"0a1b2c3d".repeat(6)}`;

let userId = "";
const agent = (): BridgeAgentConfig => ({
  key: "related-agent",
  boardId: BOARD,
  token: TOKEN,
  stationId: STATION,
  hubUserId: userId,
  mode: "full-auto",
});

const claimBody = {
  claimed: true,
  runId: RUN,
  leaseEpoch: 1,
  card: { id: CARD, title: "Ship the pricing page", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
};
const contextBody = {
  run: { runId: RUN, cardId: CARD, stageKey: "work", leaseEpoch: 1, status: "working", outcome: null, startedAt: "t", endedAt: null },
  card: { id: CARD, title: "Ship the pricing page", spec: "Build the pricing page.", currentStageKey: "work", state: "working", attemptCount: 1 },
  stage: { key: "work", name: "Work" },
  handoff: null,
  references: [],
};

function board() {
  return new SuperpipelineClient({
    baseUrl: "https://board.test",
    boardId: BOARD,
    token: TOKEN,
    fetch: async (url) => {
      const path = new URL(url).pathname;
      const body = path.endsWith("/claims") ? claimBody : path.endsWith(`/runs/${RUN}`) ? contextBody : { ok: true };
      return { status: 200, ok: true, json: async () => body };
    },
  });
}

let seq = 0;
const ev = (type: AcpEvent["type"], payload: unknown): AcpEvent => ({
  sessionId: SESSION,
  seq: ++seq,
  type,
  payload,
  createdAt: new Date().toISOString(),
});

/** An ACP port that records the prompt and ends the turn at once. */
function acp(order: string[] = []) {
  const prompts: string[] = [];
  const subs = new Set<(e: AcpEvent) => void>();
  const port: AcpPort = {
    stationReady: async () => ({ ready: true }),
    createSession: async () => {
      order.push("createSession");
      return { id: SESSION };
    },
    async promptSession(_u, _s, text) {
      prompts.push(text);
      queueMicrotask(() => {
        for (const e of [
          ev("agent-update", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }),
          ev("state", { status: "idle" }),
        ])
          subs.forEach((fn) => fn(e));
      });
    },
    subscribe(_id, fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    endSession: async () => {},
    answerPermission: async () => {},
  };
  return { port, prompts };
}

/** One claim worked start to finish; the prompt text the harness received. */
async function runOneDispatch(over: Partial<DispatchDeps> = {}, order: string[] = []): Promise<string> {
  const a = acp(order);
  await runOnce({
    client: board(),
    acp: a.port,
    agent: agent(),
    tenantId: TENANT,
    source: "superpipeline",
    heartbeatMs: 60_000,
    turnTimeoutMs: 5_000,
    log: () => {},
    ...over,
  });
  expect(a.prompts).toHaveLength(1);
  return a.prompts[0]!;
}

const item = {
  itemId: "itm_0000000000000001",
  kind: "work-record",
  title: "Pricing v1",
  outcome: "rejected",
  scope: `board:${BOARD}`,
  provenance: { board: BOARD, card: "card_0000000000000001", sourceKind: "superpipeline" },
  snippet: "Tried a toggle; rejected.",
  url: "https://app.superlibrary.dev/a/itm_0000000000000001",
  score: 1,
  supersededBy: null,
  wrapped: "",
  tokens: 10,
};

/** A Superlibrary client that records whose token each call would carry. */
function fakeLibrary() {
  const calls: Array<{ principal: string; path: string; json: unknown }> = [];
  const client = {
    asAgent: (principal: string) => ({
      request: async (_m: string, path: string, init: { json?: unknown } = {}) => {
        calls.push({ principal, path, json: init.json });
        return Response.json({ items: [item] });
      },
    }),
    asService: () => {
      throw new Error("related work is fetched with the agent's own token, never the service's");
    },
    invalidateRoster: async () => {},
  };
  return { client: client as never, calls };
}

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bridge-related" })).id;
  await db.insert(nodes).values({
    id: NODE, tenantId: TENANT, userId, name: "bridge-related-node", hostname: "bridge-related.test",
    os: "linux", arch: "arm64", status: "online", secretHash: "x", capabilities: [],
  }).onConflictDoNothing();
  await db.insert(stations).values({
    id: STATION, tenantId: TENANT, userId, nodeId: NODE, harness: "hermes", stationKey: "bridge-related",
    kind: "service", displayName: "bridge-related", principalId: PRINCIPAL, capabilities: ["acp"],
  }).onConflictDoNothing();
  const now = new Date();
  await db.insert(acpSessions).values({
    tenantId: TENANT, id: SESSION, stationId: STATION, userId, mode: "full-auto", status: "idle", lastSeq: 0,
    createdAt: now, lastEventAt: now,
  }).onConflictDoNothing();
});

let restore: (() => void) | undefined;
const clean = async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION}`;
  await db.delete(bridgeBoardSettings).where(and(eq(bridgeBoardSettings.tenantId, TENANT), eq(bridgeBoardSettings.boardId, BOARD)));
};
beforeEach(clean);
afterEach(() => {
  restore?.();
  restore = undefined;
});
afterAll(async () => {
  await clean();
  await rawSql`DELETE FROM acp_sessions WHERE id = ${SESSION}`;
  await db.delete(stations).where(eq(stations.id, STATION));
  await db.delete(nodes).where(eq(nodes.id, NODE));
});

test("the prompt section is the agent's related call", async () => {
  const seen: unknown[] = [];
  const prompt = await runOneDispatch({
    occupant: async () => PRINCIPAL,
    relatedWork: async (input) => {
      seen.push({ ...input, principal: typeof input.principal === "function" ? await input.principal() : input.principal });
      const r: CardPromptRelated = {
        itemId: "itm_0000000000000001", kind: "work-record", title: "Pricing v1", outcome: "rejected",
        url: "https://app.superlibrary.dev/a/itm_0000000000000001", text: "Tried a toggle; rejected.",
      };
      return [r];
    },
  });
  expect(seen).toEqual([{ tenantId: TENANT, boardId: BOARD, cardId: CARD, principal: PRINCIPAL }]);
  expect(prompt).toContain("## Related prior work");
  expect(prompt).toContain("Tried a toggle; rejected.");
});

test("the claim goes ahead without the section when related work is unavailable", async () => {
  const prompt = await runOneDispatch({ occupant: async () => PRINCIPAL, relatedWork: async () => undefined });
  expect(prompt).not.toContain("## Related prior work");
  expect(prompt).toContain("## Completing this card");
});

test("production wiring: the station's own principal, the agent's token, the section in the prompt", async () => {
  const lib = fakeLibrary();
  restore = setSuperlibraryClientForTests(lib.client);
  // No occupant, no relatedWork: the defaults a real claim runs on.
  const prompt = await runOneDispatch();
  expect(lib.calls).toEqual([{ principal: PRINCIPAL, path: "/api/v1/related", json: { cardId: CARD } }]);
  expect(prompt).toContain("## Related prior work");
  expect(prompt).toContain("Tried a toggle; rejected.");
  // The attempt reuses the same lookup: it records the principal the prompt was fetched for.
  const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION));
  expect(run!.agentPrincipalId).toBe(PRINCIPAL);
});

test("production wiring: a board switched off is never asked, and the claim goes ahead", async () => {
  await db.insert(bridgeBoardSettings).values({ tenantId: TENANT, boardId: BOARD, relatedWork: false });
  const lib = fakeLibrary();
  restore = setSuperlibraryClientForTests(lib.client);
  const prompt = await runOneDispatch();
  expect(lib.calls).toHaveLength(0);
  expect(prompt).not.toContain("## Related prior work");
  expect(prompt).toContain("## Completing this card");
});

test("production wiring: Superlibrary unconfigured, no section and nothing else changes", async () => {
  restore = setSuperlibraryClientForTests(null);
  const prompt = await runOneDispatch();
  expect(prompt).not.toContain("## Related prior work");
  const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION));
  expect(run!.agentPrincipalId).toBe(PRINCIPAL);
});

/** An occupant seam that records when it was asked, against the session opening. */
const recordingOccupant = (order: string[], answers: Array<string | null> = [PRINCIPAL]) => {
  let n = 0;
  return async () => {
    order.push("occupant");
    return answers[Math.min(n++, answers.length - 1)]!;
  };
};

test("Superlibrary unconfigured: the occupant is not looked up before the session opens", async () => {
  restore = setSuperlibraryClientForTests(null);
  const order: string[] = [];
  await runOneDispatch({ occupant: recordingOccupant(order) }, order);
  // The old timing: one lookup, at the attempt's first ACP event, after the session exists.
  expect(order).toEqual(["createSession", "occupant"]);
  const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION));
  expect(run!.agentPrincipalId).toBe(PRINCIPAL);
});

test("a board switched off: the occupant is not looked up before the session opens either", async () => {
  await db.insert(bridgeBoardSettings).values({ tenantId: TENANT, boardId: BOARD, relatedWork: false });
  restore = setSuperlibraryClientForTests(fakeLibrary().client);
  const order: string[] = [];
  await runOneDispatch({ occupant: recordingOccupant(order) }, order);
  expect(order).toEqual(["createSession", "occupant"]);
});

test("related work on: one lookup before the session, and the attempt reuses it", async () => {
  const lib = fakeLibrary();
  restore = setSuperlibraryClientForTests(lib.client);
  const order: string[] = [];
  await runOneDispatch({ occupant: recordingOccupant(order) }, order);
  expect(order).toEqual(["occupant", "createSession"]);
  expect(lib.calls.map((c) => c.principal)).toEqual([PRINCIPAL]);
  const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION));
  expect(run!.agentPrincipalId).toBe(PRINCIPAL);
});

test("related work on, no principal at prompt time: the attempt looks again, as it always did", async () => {
  const lib = fakeLibrary();
  restore = setSuperlibraryClientForTests(lib.client);
  const order: string[] = [];
  await runOneDispatch({ occupant: recordingOccupant(order, [null, PRINCIPAL]) }, order);
  expect(order).toEqual(["occupant", "createSession", "occupant"]);
  expect(lib.calls).toHaveLength(0);
  const [run] = await db.select().from(acpRuns).where(eq(acpRuns.stationId, STATION));
  expect(run!.agentPrincipalId).toBe(PRINCIPAL);
});
