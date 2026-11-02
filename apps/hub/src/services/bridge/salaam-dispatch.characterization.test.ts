/**
 * Characterization: the exact traffic of the strict Salaam dispatch path, pinned before it splits.
 *
 * tests/integration/salaam-work.test.ts proves the rules one by one (one driver, lost replies,
 * parking, settlement proofs). This file pins the WHOLE of what each exported operation of
 * salaam-dispatch.ts sends and writes, in order, as it is today:
 *
 *   - every board call (method and arguments) and every Salaam node verb (verb, params, options),
 *   - every ACP port call, the attempt span, the strict-work log lines with their meta,
 *   - the ledger (`bridge_dispatches`), the work owner and its settlement, as each call is sent,
 *   - the result or the error each operation ends with.
 *
 * Volatile values (ids, uuids, digests, timestamps) are replaced by placeholders before comparing.
 * Each test makes its own run, board and agent, so it passes alone (`-t`) and in any order.
 * Uses the local Docker test-postgres (localhost:5434).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/drizzle";
import { tenants } from "../../db/schema/tenants";
import { nodes } from "../../db/schema/nodes";
import { stations } from "../../db/schema/stations";
import { acpSessions } from "../../db/schema/acp";
import { bridgeDispatches } from "../../db/schema/bridge";
import { salaamWorkOwners, salaamWorkReports } from "../../db/schema/salaam-work";
import { AgentSpanRecorder } from "../../telemetry/agent-spans";
import { makeSalaamExecution, workDigest } from "../salaam";
import * as broker from "../broker/broker";
import { fakePlane } from "../../../tests/helpers/fake-plane";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import corpus from "../../../../../packages/contract/src/fixtures/salaam-work-payload-v1.json";
import { openDispatch } from "./ledger";
import { reserveSalaamWork } from "./salaam-work";
import type { AcpPort, DispatchDeps } from "./dispatch-types";
import { SuperpipelineClient, type ClaimedWork, type RunContext } from "./superpipeline";
import {
  SALAAM_RERUN_ALLOWANCE,
  probeSalaamWork,
  reconcileUnopenedSalaamRelease,
  recoverExpiredSalaamDecision,
  resumeSalaamWork,
  settleNeverDispatchedSalaamWork,
  settleStoppedSalaamWork,
  startSalaamWork,
} from "./salaam-dispatch";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw Error(what + " is missing");
  return value;
}

const hex = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);
const tenantId = "fleet_" + hex(),
  org = "org_" + hex(),
  user = "prn_" + hex(),
  node = "node_" + hex(),
  plainStation = "station_" + hex();
const plan = must(corpus.cases[0], "the corpus case").payload.plan;
const TASK = "99999999-9999-4999-8999-999999999999";
const TOKEN = `spa_${"c4a7c4a7".repeat(6)}`;
const stationBase = () => ({
  tenantId, userId: user, nodeId: node, kind: "leaf", displayName: "char", workspacePath: "/workspace",
  capabilities: ["acp"],
});
const refuseSettlement = async () => {
  throw Error("no proof");
};
const runPrincipals: string[] = [];

beforeAll(async () => {
  await ensurePgMigrations();
  fakePlane.addHuman({ id: user, grant: { mayDispatch: [] } });
  must(fakePlane.principals.get(user), "the user").organizationId = org;
  await db.insert(tenants).values({ id: tenantId, name: "strict char", externalSource: "org-plane", externalId: org });
  await db.insert(nodes).values({
    id: node, tenantId, userId: user, name: "char", hostname: "fixture", os: "test", arch: "test", secretHash: "x",
  });
  await db.insert(stations).values({ ...stationBase(), id: plainStation, harness: "opencode", stationKey: "opencode:char" });
});

afterAll(async () => {
  const owners = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.tenantId, tenantId));
  for (const o of owners) await db.delete(salaamWorkReports).where(eq(salaamWorkReports.workRequestId, o.requestId));
  await db.delete(salaamWorkOwners).where(eq(salaamWorkOwners.tenantId, tenantId));
  await db.delete(acpSessions).where(eq(acpSessions.tenantId, tenantId));
  await db.delete(bridgeDispatches).where(eq(bridgeDispatches.tenantId, tenantId));
  await db.delete(stations).where(eq(stations.tenantId, tenantId));
  await db.delete(nodes).where(eq(nodes.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  fakePlane.remove(user);
  for (const p of runPrincipals) fakePlane.remove(p);
});

// ─── Rig ──────────────────────────────────────────────────────────────────────

type Entry = Record<string, unknown>;
type Answer = { ok: boolean; data?: unknown; error?: string };
/** A board reply: `null` lets the default route answer. */
type Route = (method: string, path: string, body: unknown) => Promise<Answer | null> | Answer | null;

interface Run {
  station: string;
  principal: string;
  runId: string;
  cardId: string;
  boardId: string;
  agentKey: string;
  claim: ClaimedWork;
  live: RunContext;
  trace: Entry[];
  names: Record<string, string>;
  sessionId?: string;
  lastLedger?: string;
}

/** A run on its own Salaam station (one active execution per station), with its own agent. */
async function newRun(): Promise<Run> {
  const principal = fakePlane.addAgent({ id: "prn_" + hex() }),
    station = "station_" + hex(),
    stationKey = "salaam:" + hex().slice(0, 16);
  runPrincipals.push(principal);
  must(fakePlane.principals.get(principal), "the agent").organizationId = org;
  must(must(fakePlane.principals.get(user), "the user").grant, "the grant").mayDispatch.push(principal);
  await db.insert(stations).values({ ...stationBase(), id: station, harness: "salaam", stationKey, principalId: principal });
  const runId = "run_" + hex(),
    cardId = "card_" + hex(),
    boardId = "brd_" + hex(),
    agentKey = "agent_" + hex();
  const card = { id: cardId, title: "Proof", spec: { salaam: { version: 1, plan } } };
  const claim: ClaimedWork = { runId, leaseEpoch: 1, card, stage: { key: "build", name: "Build" }, handoff: null };
  const live: RunContext = {
    run: {
      runId, cardId, stageKey: "build", leaseEpoch: 1, status: "working", outcome: null,
      startedAt: "now", endedAt: null, handoff: null, completion: null,
    },
    card, stage: claim.stage, handoff: null, references: [],
  };
  return {
    station, principal, runId, cardId, boardId, agentKey, claim, live, trace: [],
    names: {
      [stationKey]: "<station-key>", [station]: "<station>", [principal]: "<principal>", [runId]: "<run>",
      [cardId]: "<card>", [boardId]: "<board>", [agentKey]: "<agent>",
    },
  };
}

function ended(r: Run, outcome: string) {
  r.live = { ...r.live, run: { ...r.live.run, status: "ended", outcome, endedAt: "2026-10-20T18:00:00.000Z" } };
}

/** Replace ids, uuids, digests and times with placeholders. */
async function normalize(r: Run, value: unknown): Promise<unknown> {
  let text = JSON.stringify(value);
  if (r.sessionId) {
    const [w] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.sessionId, r.sessionId));
    if (w) text = text.split(w.requestId).join("<work>");
    text = text.split(r.sessionId).join("<session>");
  }
  const names: Record<string, string> = {
    ...r.names, [tenantId]: "<tenant>", [org]: "<org>", [user]: "<user>", [node]: "<node>",
    [plainStation]: "<plain-station>", [TASK]: "<task>", [TOKEN]: "<token>",
  };
  for (const [literal, name] of Object.entries(names)) text = text.split(literal).join(name);
  text = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b[a-f0-9]{64}\b/g, "<digest>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

async function ledger(r: Run) {
  const [d] = await db.select().from(bridgeDispatches).where(eq(bridgeDispatches.externalRunId, r.runId));
  const [w] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.externalRunId, r.runId));
  return {
    dispatch: d ? { outcome: d.outcome, reason: d.reason, result: d.result === null ? null : "<set>" } : null,
    owner: w
      ? { receipt: w.receipt === null ? null : "<set>", settlement: w.settlement, telemetry: w.telemetryStatus }
      : null,
  };
}

/** Push `entry`, with the ledger attached only when it differs from the last one the trace saw. */
async function record(r: Run, entry: Entry) {
  const now = await ledger(r),
    text = JSON.stringify(now);
  if (text !== r.lastLedger) entry.ledger = now;
  r.lastLedger = text;
  r.trace.push(entry);
}

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;

/** The node verbs: each call goes into the trace with its params, then gets `answer`'s reply. */
function nodeVerbs(r: Run, answer: (verb: string, params: unknown) => Answer | Promise<Answer>) {
  return spyOn(broker, "request").mockImplementation(
    async (_node: string, verb: string, params: unknown, opts?: { timeoutMs?: number }) => {
      await record(r, { node: verb, params, ...(opts ? { opts } : {}) });
      return answer(verb, params);
    },
  );
}

const logLine = z.object({ component: z.string(), message: z.string(), context: z.unknown() }).partial();

/** The strict-work log lines ("salaam work: …") as trace entries, in order. */
function workLogs(r: Run) {
  return spyOn(console, "log").mockImplementation((line?: unknown) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(line));
    } catch {
      return;
    }
    const entry = logLine.safeParse(parsed);
    if (entry.success && entry.data.component === "bridge" && entry.data.message?.startsWith("salaam work"))
      r.trace.push({ log: entry.data.message, meta: entry.data.context });
  });
}

async function insertSession(r: Run) {
  const id = "acps_" + hex();
  const execution = await makeSalaamExecution(r.station, user, id, { source: "superpipeline", id: r.runId, epoch: 1 });
  execution.sessionId = crypto.randomUUID();
  execution.admissionId = crypto.randomUUID();
  await db.insert(acpSessions).values({
    id, tenantId, stationId: r.station, userId: user, mode: "ask", status: "idle",
    executionAuthority: execution, createdAt: new Date(), lastEventAt: new Date(),
  });
  r.sessionId = id;
  return id;
}

async function authority(r: Run) {
  const id = must(r.sessionId, "the session");
  const [s] = await db.select().from(acpSessions).where(eq(acpSessions.id, id));
  return { id, execution: must(s?.executionAuthority, "the execution authority") };
}

async function revoke(r: Run) {
  const { id, execution } = await authority(r);
  await db.update(acpSessions).set({ executionAuthority: { ...execution, state: "revoked" } }).where(eq(acpSessions.id, id));
}

/** Revoke the run's session with an exact stopped receipt (what an ended strict session leaves). */
async function stopSession(r: Run, interrupted: string[] = []) {
  const { id, execution } = await authority(r);
  const a = structuredClone(execution);
  a.state = "revoked";
  a.receipt = {
    admission_id: must(a.admissionId, "the admission"), session_id: must(a.sessionId, "the Salaam session"), binding: a.binding, binding_digest: workDigest(a.binding),
    lease_sequence: 1, expires_at: 1, authorized: false, revoked: true, owned_execution_stopped: true,
    unresolved_operations: [], active_attempts: [], interrupted_attempts: interrupted,
  };
  await db.update(acpSessions).set({ status: "ended", executionAuthority: a }).where(eq(acpSessions.id, id));
  return { sessionId: must(a.sessionId, "the Salaam session"), digest: workDigest(a.binding) };
}

async function openRunDispatch(r: Run) {
  await openDispatch({
    tenantId, externalSource: "superpipeline", externalRunId: r.runId, externalCardId: r.cardId,
    boardId: r.boardId, agentKey: r.agentKey, stationId: r.station, leaseEpoch: 1,
  });
}

/** A dispatch, an active session and an admitted work owner for `r`: what a driven run leaves. */
async function admitted(r: Run) {
  await openRunDispatch(r);
  const sid = await insertSession(r);
  const work = await reserveSalaamWork(sid, user, r.claim, r.live, plan);
  await db.update(salaamWorkOwners).set({ receipt: { task_id: TASK, plan_revision: 1 } })
    .where(eq(salaamWorkOwners.requestId, work.requestId));
  return work;
}

interface RigOpts {
  route?: Route;
  createSession?: "fail";
  ensure?: "live" | "waiting" | "gone";
  deps?: Partial<DispatchDeps>;
}

/** The board as a real client over a recording fetch, and an ACP port that records each call. */
function deps(r: Run, o: RigOpts = {}): DispatchDeps {
  const client = new SuperpipelineClient({
    baseUrl: "https://board.test",
    boardId: r.boardId,
    token: TOKEN,
    fetch: async (url, init) => {
      const path = new URL(url).pathname.replace(`/v1/boards/${r.boardId}`, "");
      const method = init.method ?? "GET";
      const body: unknown = init.body ? JSON.parse(init.body) : undefined;
      await record(r, { board: `${method} ${path}`, ...(body === undefined ? {} : { body }) });
      let reply = (await o.route?.(method, path, body)) ?? null;
      if (!reply && method === "GET" && path === `/runs/${r.runId}`) reply = { ok: true, data: structuredClone(r.live) };
      if (!reply && path.endsWith("/complete")) {
        r.live = {
          ...r.live,
          run: { ...r.live.run, status: "ended", outcome: "completed", handoff: field(body, "handoff"), completion: { met: true, outcome: "pass" } },
        };
      }
      reply ??= { ok: true, data: {} };
      const answer = reply;
      return {
        status: answer.ok ? 200 : 409,
        ok: answer.ok,
        json: async () => (answer.ok ? answer.data : { error: { code: "STALE_LEASE", message: answer.error } }),
      };
    },
  });
  const acp: AcpPort = {
    async stationReady() {
      return { ready: true };
    },
    async createSession(input) {
      const { validateExecutionRun, ...rest } = input;
      await record(r, { acp: "createSession", input: rest, validates: typeof validateExecutionRun });
      if (o.createSession === "fail") throw Error("startup refused");
      return { id: await insertSession(r) };
    },
    async promptSession() {
      throw Error("a strict run never prompts");
    },
    subscribe() {
      return () => {};
    },
    async endSession(userId, sessionId, reason) {
      await record(r, { acp: "endSession", userId, sessionId, reason });
    },
    async answerPermission() {
      throw Error("a strict run never answers an ACP permission");
    },
    async renewExecution(userId, sessionId, run) {
      await record(r, { acp: "renewExecution", userId, sessionId, run });
    },
  };
  const ensure = o.ensure;
  if (ensure)
    acp.ensureStrictSession = async (userId, sessionId) => {
      await record(r, { acp: "ensureStrictSession", userId, sessionId });
      return ensure;
    };
  return {
    tenantId,
    source: "superpipeline",
    permissionPollMs: 0,
    agent: { key: r.agentKey, boardId: r.boardId, token: TOKEN, stationId: r.station, hubUserId: user, mode: "ask" },
    client,
    acp,
    salaamPublish: async () => ({ agent: { summary: "done" }, deliverables: [], publication: "none" }),
    ...o.deps,
  };
}

/** Salaam's answers for a run that is admitted, progresses, and reports `states` one per poll. */
function salaamScript(r: Run, states: Entry[], over: Record<string, Answer> = {}) {
  let polls = 0;
  return async (verb: string, params: unknown): Promise<Answer> => {
    const planted = over[verb];
    if (planted) return planted;
    const [w] = await db.select().from(salaamWorkOwners).where(eq(salaamWorkOwners.externalRunId, r.runId));
    const work = must(w, "the work owner").requestId;
    const binding_digest = workDigest(field(params, "binding") ?? field(field(params, "admission"), "binding"));
    const { execution } = await authority(r);
    const base = { version: 1, work_request_id: work, task_id: TASK, plan_revision: 1, binding_digest };
    switch (verb) {
      case "salaam.work-admit":
        return { ok: true, data: { version: 1, state: "admitted", session_id: execution.sessionId, task_id: TASK, request_id: work, binding_digest, plan_revision: 1 } };
      case "salaam.work-progress":
        return { ok: true, data: { ...base, request_id: work } };
      case "salaam.work-status":
        return { ok: true, data: { ...base, auto_enabled: true, ...states[Math.min(polls++, states.length - 1)] } };
      case "salaam.work-decisions":
        return { ok: true, data: { version: 1, decisions: [] } };
      case "salaam.work-completion":
        return { ok: true, data: { ...base, state: "verified", completion_id: "c1", evidence_digest: "e".repeat(64) } };
    }
    return { ok: false, error: "unexpected verb " + verb };
  };
}

async function settle(p: Promise<unknown>): Promise<{ result: unknown } | { error: string }> {
  try {
    return { result: await p };
  } catch (error) {
    return { error: String(error) };
  }
}

// ─── probeSalaamWork ─────────────────────────────────────────────────────────

test("probeSalaamWork: the capability verb, and what each answer selects", async () => {
  const r = await newRun();
  const answers: Answer[] = [
    { ok: true, data: { version: 1, enabled: true } },
    { ok: true, data: { version: 2, enabled: true } },
    { ok: false, error: "offline" },
  ];
  const spy = nodeVerbs(r, () => must(answers.shift(), "an answer"));
  try {
    const out = [];
    out.push(await probeSalaamWork({ stationId: plainStation, tenantId, userId: user }));
    out.push(await probeSalaamWork({ stationId: r.station, tenantId: "fleet_" + "0".repeat(20), userId: user }));
    for (let i = 0; i < 3; i++) out.push(await probeSalaamWork({ stationId: r.station, tenantId, userId: user }));
    expect(await normalize(r, { out, trace: r.trace.map((e) => ({ node: e.node, params: e.params })) })).toMatchInlineSnapshot(`
      {
        "out": [
          {
            "required": false,
            "version": null,
          },
          {
            "required": false,
            "version": null,
          },
          {
            "required": true,
            "version": 1,
          },
          {
            "reason": "Salaam strict work version 1 is not freshly available",
            "required": true,
            "version": null,
          },
          {
            "reason": "Salaam strict work version 1 is not freshly available",
            "required": true,
            "version": null,
          },
        ],
        "trace": [
          {
            "node": "salaam.work-capability",
            "params": {
              "node_id": "<node>",
              "station_key": "<station-key>",
              "workspace": "/workspace",
            },
          },
          {
            "node": "salaam.work-capability",
            "params": {
              "node_id": "<node>",
              "station_key": "<station-key>",
              "workspace": "/workspace",
            },
          },
          {
            "node": "salaam.work-capability",
            "params": {
              "node_id": "<node>",
              "station_key": "<station-key>",
              "workspace": "/workspace",
            },
          },
        ],
      }
    `);
  } finally {
    spy.mockRestore();
  }
});

// ─── startSalaamWork and the drive ───────────────────────────────────────────

test("startSalaamWork: a full strict run, from claim to verified report", async () => {
  const r = await newRun();
  const spy = nodeVerbs(r, salaamScript(r, [{ state: "running" }, { state: "succeeded" }]));
  const logs = workLogs(r);
  try {
    const spans = new AgentSpanRecorder({
      tracer: otelTrace.getTracer("salaam-dispatch-char"),
      parent: otelContext.active(),
      stationId: r.station,
      onOpen: (facts) => r.trace.push({ span: "openAttempt", facts }),
    });
    const result = await startSalaamWork(deps(r), r.claim, spans);
    expect(await normalize(r, { result, trace: r.trace, after: await ledger(r), allowance: SALAAM_RERUN_ALLOWANCE })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "reported",
            "reason": null,
            "result": "<set>",
          },
          "owner": {
            "receipt": "<set>",
            "settlement": null,
            "telemetry": null,
          },
        },
        "allowance": 3,
        "result": {
          "externalRunId": "<run>",
          "status": "reported",
        },
        "trace": [
          {
            "board": "GET /runs/<run>",
            "ledger": {
              "dispatch": null,
              "owner": null,
            },
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": null,
            },
          },
          {
            "acp": "createSession",
            "input": {
              "executionRun": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "mcpProxy": false,
              "mode": "ask",
              "stationId": "<station>",
              "tenantId": "<tenant>",
              "userId": "<user>",
            },
            "validates": "function",
          },
          {
            "log": "salaam work: drive",
            "meta": {
              "agent": "<agent>",
              "run": "<run>",
              "session": "<session>",
            },
          },
          {
            "board": "GET /runs/<run>",
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": null,
                "settlement": null,
                "telemetry": null,
              },
            },
          },
          {
            "log": "salaam work: deliver",
            "meta": {
              "run": "<run>",
              "work": "<work>",
            },
          },
          {
            "node": "salaam.work-admit",
            "params": {
              "admission": {
                "binding": {
                  "hub_session_id": "<session>",
                  "node_id": "<node>",
                  "occupancy_epoch": 1,
                  "organization_id": "<org>",
                  "principal_id": "<principal>",
                  "run": {
                    "epoch": 1,
                    "id": "<run>",
                    "source": "superpipeline",
                  },
                  "station_id": "<station>",
                  "station_key": "<station-key>",
                  "version": 1,
                  "workspace": "/workspace",
                },
                "request_id": "<work>",
                "version": 1,
                "work": {
                  "board_id": "<board>",
                  "card_id": "<card>",
                  "input_digest": "<digest>",
                  "plan_digest": "<digest>",
                  "stage_key": "build",
                },
              },
              "input": {
                "incoming_handoff": null,
                "instructions": "{"card":{"id":"<card>","title":"Proof","spec":{"salaam":{"version":1,"plan":{"objective":"Inspect","constraints":[],"steps":[{"key":"inspect","title":"Inspect","instruction":"Read source","depends_on":[],"checks":["verify"]}],"acceptance":[{"key":"verify","command":"test -f src/a.ts","cwd":"."}],"deliverables":["src/a.ts"],"limits":{"requests":2,"runtime_ms":10000,"concurrency":1,"token_units":10000,"input_token_bound":1024,"output_token_bound":1024,"verification_runs":2}}}}},"stage":{"key":"build","name":"Build"},"comments":[],"commentsOmitted":0}",
                "references": [],
              },
              "plan": {
                "acceptance": [
                  {
                    "command": "cd 'runs/<run>' && (test -f src/a.ts)",
                    "cwd": ".",
                    "key": "verify",
                  },
                ],
                "constraints": [
                  "Work only inside runs/<run>/ in the workspace, and create it first. Every path in this plan, including each check's directory and every deliverable, is relative to runs/<run>/.",
                  "Before you finish, write runs/<run>/handoff.json: one JSON object for the next stage, with "summary" (what you did and found), "findings", "acceptance" (each criterion and how it was met) and "evidence" (sources and checks). It is verified and reported with your work.",
                ],
                "deliverables": [
                  "runs/<run>/src/a.ts",
                  "runs/<run>/handoff.json",
                ],
                "limits": {
                  "concurrency": 1,
                  "input_token_bound": 1024,
                  "output_token_bound": 1024,
                  "requests": 2,
                  "runtime_ms": 10000,
                  "token_units": 10000,
                  "verification_runs": 2,
                },
                "objective": "Inspect",
                "steps": [
                  {
                    "checks": [
                      "verify",
                    ],
                    "depends_on": [],
                    "instruction": "Read source",
                    "key": "inspect",
                    "title": "Inspect",
                  },
                ],
              },
            },
          },
          {
            "log": "salaam work: admitted",
            "meta": {
              "plan": 1,
              "run": "<run>",
              "task": "<task>",
            },
          },
          {
            "facts": {
              "attemptId": "<work>",
              "fingerprintDigest": "<digest>",
              "harnessName": "salaam",
              "sessionId": "<session>",
              "startSeq": 0,
            },
            "span": "openAttempt",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "log": "salaam work: trace",
            "meta": {
              "run": "<run>",
              "status": "unreported",
            },
          },
          {
            "node": "salaam.work-progress",
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
              "compact": false,
              "max_steps": 4,
              "request_id": "<work>",
              "work_request_id": "<work>",
            },
          },
          {
            "log": "salaam work: progress acknowledged",
            "meta": {
              "run": "<run>",
              "steps": 1,
            },
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "node": "salaam.work-status",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "log": "salaam work: status",
            "meta": {
              "auto": true,
              "run": "<run>",
              "state": "running",
            },
          },
          {
            "node": "salaam.work-decisions",
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "node": "salaam.work-status",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "log": "salaam work: status",
            "meta": {
              "auto": true,
              "run": "<run>",
              "state": "succeeded",
            },
          },
          {
            "board": "GET /runs/<run>",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "node": "salaam.work-completion",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "board": "GET /runs/<run>",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "node": "salaam.work-completion",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "board": "POST /runs/<run>/heartbeat",
            "body": {
              "leaseEpoch": 1,
            },
          },
          {
            "acp": "renewExecution",
            "run": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "node": "salaam.work-completion",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "board": "POST /runs/<run>/complete",
            "body": {
              "handoff": {
                "deliverables": [],
                "publication": "none",
                "summary": "done",
                "verification": {
                  "completion": {
                    "binding_digest": "<digest>",
                    "completion_id": "c1",
                    "evidence_digest": "<digest>",
                    "plan_revision": 1,
                    "state": "verified",
                    "task_id": "<task>",
                    "version": 1,
                    "work_request_id": "<work>",
                  },
                  "report_request_id": "<uuid>",
                  "source": "salaam",
                  "version": 1,
                },
              },
              "leaseEpoch": 1,
              "outcome": "pass",
            },
          },
          {
            "board": "GET /runs/<run>",
          },
          {
            "acp": "endSession",
            "ledger": {
              "dispatch": {
                "outcome": "reported",
                "reason": null,
                "result": "<set>",
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
            "reason": "Strict work reported",
            "sessionId": "<session>",
            "userId": "<user>",
          },
        ],
      }
    `);
  } finally {
    spy.mockRestore();
    logs.mockRestore();
  }
});

test("startSalaamWork: a startup failure before a session releases the claim and the ledger", async () => {
  const r = await newRun();
  const result = await startSalaamWork(deps(r, { createSession: "fail" }), r.claim);
  expect(await normalize(r, { result, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "released",
          "reason": "Error: startup refused",
          "result": null,
        },
        "owner": null,
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Error: startup refused",
        "status": "released",
      },
      "trace": [
        {
          "board": "GET /runs/<run>",
          "ledger": {
            "dispatch": null,
            "owner": null,
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": null,
          },
        },
        {
          "acp": "createSession",
          "input": {
            "executionRun": {
              "epoch": 1,
              "id": "<run>",
              "source": "superpipeline",
            },
            "mcpProxy": false,
            "mode": "ask",
            "stationId": "<station>",
            "tenantId": "<tenant>",
            "userId": "<user>",
          },
          "validates": "function",
        },
        {
          "board": "POST /runs/<run>/release",
          "body": {
            "leaseEpoch": 1,
          },
        },
      ],
    }
  `);
});

test("startSalaamWork: a second driver on the same run is turned away; a card without a plan is released", async () => {
  const r = await newRun();
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const noPlan: RunContext = { ...r.live, card: { id: r.cardId, title: "Proof" } };
  const d = deps(r, {
    route: async (method, path) => {
      if (method !== "GET" || path !== `/runs/${r.runId}`) return null;
      await gate;
      return { ok: true, data: noPlan };
    },
  });
  const first = startSalaamWork(d, r.claim);
  const second = await startSalaamWork(d, r.claim);
  open?.();
  expect(await normalize(r, { second, first: await first, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": null,
        "owner": null,
      },
      "first": {
        "externalRunId": "<run>",
        "reason": "Error: Strict Salaam work requires an explicit spec.salaam plan",
        "status": "released",
      },
      "second": {
        "externalRunId": "<run>",
        "reason": "Another driver in this hub owns this strict run",
        "status": "idle",
      },
      "trace": [
        {
          "board": "GET /runs/<run>",
          "ledger": {
            "dispatch": null,
            "owner": null,
          },
        },
        {
          "board": "POST /runs/<run>/release",
          "body": {
            "leaseEpoch": 1,
          },
        },
      ],
    }
  `);
});

const STOPS: [string, Entry[], Record<string, Answer>, Partial<DispatchDeps>][] = [
  ["a failed task stops the session", [{ state: "failed" }], {}, {}],
  ["a refused progression stops nothing", [], { "salaam.work-progress": { ok: false, error: "refused" } }, {}],
  ["bounded progression with no decision stops the session", [{ state: "running", auto_enabled: false }], {}, {}],
  ["a handover returns before any status", [], {}, { handover: AbortSignal.abort() }],
  ["a changed task id stops nothing", [{ state: "running", task_id: "88888888-8888-4888-8888-888888888888" }], {}, {}],
];

/** One way a driven run stops: its trace after the admission, its result and its ledger. */
async function driveStop(name: string) {
  const [, states, over, extra] = must(STOPS.find(([n]) => n === name), "the case");
  const r = await newRun();
  const spy = nodeVerbs(r, salaamScript(r, states, over));
  const logs = workLogs(r);
  try {
    const result = await startSalaamWork(deps(r, { deps: extra }), r.claim);
    const from = r.trace.findIndex((e) => e.node === "salaam.work-admit");
    return await normalize(r, { result, trace: r.trace.slice(from + 1), after: await ledger(r) });
  } finally {
    spy.mockRestore();
    logs.mockRestore();
  }
}

test("drive: a failed task stops the session", async () => {
  expect(await driveStop("a failed task stops the session")).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "working",
          "reason": null,
          "result": null,
        },
        "owner": {
          "receipt": "<set>",
          "settlement": null,
          "telemetry": null,
        },
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Error: Strict task did not satisfy full acceptance: failed",
        "status": "failed",
      },
      "trace": [
        {
          "log": "salaam work: admitted",
          "meta": {
            "plan": 1,
            "run": "<run>",
            "task": "<task>",
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "log": "salaam work: trace",
          "meta": {
            "run": "<run>",
            "status": "unreported",
          },
        },
        {
          "node": "salaam.work-progress",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
            "compact": false,
            "max_steps": 4,
            "request_id": "<work>",
            "work_request_id": "<work>",
          },
        },
        {
          "log": "salaam work: progress acknowledged",
          "meta": {
            "run": "<run>",
            "steps": 1,
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "node": "salaam.work-status",
          "opts": {
            "timeoutMs": 125000,
          },
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
          },
        },
        {
          "log": "salaam work: status",
          "meta": {
            "auto": true,
            "run": "<run>",
            "state": "failed",
          },
        },
        {
          "log": "salaam work: failed",
          "meta": {
            "error": "Error: Strict task did not satisfy full acceptance: failed",
            "run": "<run>",
            "stopping": true,
          },
        },
        {
          "acp": "endSession",
          "reason": "Strict work stopped: Error: Strict task did not satisfy full acceptance: failed",
          "sessionId": "<session>",
          "userId": "<user>",
        },
      ],
    }
  `);
});
test("drive: a refused progression stops nothing", async () => {
  expect(await driveStop("a refused progression stops nothing")).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "working",
          "reason": null,
          "result": null,
        },
        "owner": {
          "receipt": "<set>",
          "settlement": null,
          "telemetry": null,
        },
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Error: Strict bounded progression was not acknowledged; recover original request",
        "status": "failed",
      },
      "trace": [
        {
          "log": "salaam work: admitted",
          "meta": {
            "plan": 1,
            "run": "<run>",
            "task": "<task>",
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "log": "salaam work: trace",
          "meta": {
            "run": "<run>",
            "status": "unreported",
          },
        },
        {
          "node": "salaam.work-progress",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
            "compact": false,
            "max_steps": 4,
            "request_id": "<work>",
            "work_request_id": "<work>",
          },
        },
        {
          "log": "salaam work: progress refused",
          "meta": {
            "error": "refused",
            "ok": false,
            "run": "<run>",
          },
        },
        {
          "log": "salaam work: failed",
          "meta": {
            "error": "Error: Strict bounded progression was not acknowledged; recover original request",
            "run": "<run>",
            "stopping": false,
          },
        },
      ],
    }
  `);
});
test("drive: bounded progression with no decision stops the session", async () => {
  expect(await driveStop("bounded progression with no decision stops the session")).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "working",
          "reason": null,
          "result": null,
        },
        "owner": {
          "receipt": "<set>",
          "settlement": null,
          "telemetry": null,
        },
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Error: Bounded progression stopped; explicit task review is required",
        "status": "failed",
      },
      "trace": [
        {
          "log": "salaam work: admitted",
          "meta": {
            "plan": 1,
            "run": "<run>",
            "task": "<task>",
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "log": "salaam work: trace",
          "meta": {
            "run": "<run>",
            "status": "unreported",
          },
        },
        {
          "node": "salaam.work-progress",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
            "compact": false,
            "max_steps": 4,
            "request_id": "<work>",
            "work_request_id": "<work>",
          },
        },
        {
          "log": "salaam work: progress acknowledged",
          "meta": {
            "run": "<run>",
            "steps": 1,
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "node": "salaam.work-status",
          "opts": {
            "timeoutMs": 125000,
          },
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
          },
        },
        {
          "log": "salaam work: status",
          "meta": {
            "auto": false,
            "run": "<run>",
            "state": "running",
          },
        },
        {
          "node": "salaam.work-decisions",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
          },
        },
        {
          "log": "salaam work: failed",
          "meta": {
            "error": "Error: Bounded progression stopped; explicit task review is required",
            "run": "<run>",
            "stopping": true,
          },
        },
        {
          "acp": "endSession",
          "reason": "Strict work stopped: Error: Bounded progression stopped; explicit task review is required",
          "sessionId": "<session>",
          "userId": "<user>",
        },
      ],
    }
  `);
});
test("drive: a handover returns before any status", async () => {
  expect(await driveStop("a handover returns before any status")).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "working",
          "reason": null,
          "result": null,
        },
        "owner": {
          "receipt": "<set>",
          "settlement": null,
          "telemetry": null,
        },
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Strict work handed over to the rebuilt loop",
        "status": "failed",
      },
      "trace": [
        {
          "log": "salaam work: admitted",
          "meta": {
            "plan": 1,
            "run": "<run>",
            "task": "<task>",
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "log": "salaam work: trace",
          "meta": {
            "run": "<run>",
            "status": "unreported",
          },
        },
        {
          "node": "salaam.work-progress",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
            "compact": false,
            "max_steps": 4,
            "request_id": "<work>",
            "work_request_id": "<work>",
          },
        },
        {
          "log": "salaam work: progress acknowledged",
          "meta": {
            "run": "<run>",
            "steps": 1,
          },
        },
        {
          "log": "salaam work: handed over",
          "meta": {
            "run": "<run>",
          },
        },
      ],
    }
  `);
});
test("drive: a changed task id stops nothing", async () => {
  expect(await driveStop("a changed task id stops nothing")).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "working",
          "reason": null,
          "result": null,
        },
        "owner": {
          "receipt": "<set>",
          "settlement": null,
          "telemetry": null,
        },
      },
      "result": {
        "externalRunId": "<run>",
        "reason": "Error: Strict task status changed owner or plan",
        "status": "failed",
      },
      "trace": [
        {
          "log": "salaam work: admitted",
          "meta": {
            "plan": 1,
            "run": "<run>",
            "task": "<task>",
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "log": "salaam work: trace",
          "meta": {
            "run": "<run>",
            "status": "unreported",
          },
        },
        {
          "node": "salaam.work-progress",
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
            "compact": false,
            "max_steps": 4,
            "request_id": "<work>",
            "work_request_id": "<work>",
          },
        },
        {
          "log": "salaam work: progress acknowledged",
          "meta": {
            "run": "<run>",
            "steps": 1,
          },
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "board": "POST /runs/<run>/heartbeat",
          "body": {
            "leaseEpoch": 1,
          },
        },
        {
          "acp": "renewExecution",
          "run": {
            "epoch": 1,
            "id": "<run>",
            "source": "superpipeline",
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
        {
          "node": "salaam.work-status",
          "opts": {
            "timeoutMs": 125000,
          },
          "params": {
            "binding": {
              "hub_session_id": "<session>",
              "node_id": "<node>",
              "occupancy_epoch": 1,
              "organization_id": "<org>",
              "principal_id": "<principal>",
              "run": {
                "epoch": 1,
                "id": "<run>",
                "source": "superpipeline",
              },
              "station_id": "<station>",
              "station_key": "<station-key>",
              "version": 1,
              "workspace": "/workspace",
            },
          },
        },
        {
          "log": "salaam work: status",
          "meta": {
            "auto": true,
            "run": "<run>",
            "state": "running",
          },
        },
        {
          "log": "salaam work: failed",
          "meta": {
            "error": "Error: Strict task status changed owner or plan",
            "run": "<run>",
            "stopping": false,
          },
        },
      ],
    }
  `);
});

// ─── resumeSalaamWork ───────────────────────────────────────────────────────

test("resumeSalaamWork: a session waiting for its node is left idle", async () => {
  const r = await newRun();
  await admitted(r);
  const result = await resumeSalaamWork(deps(r, { ensure: "waiting" }));
  expect(await normalize(r, { result, trace: r.trace })).toMatchInlineSnapshot(`
    {
      "result": {
        "externalRunId": "<run>",
        "reason": "Strict session is waiting for its station node to reconnect",
        "status": "idle",
      },
      "trace": [
        {
          "acp": "ensureStrictSession",
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": {
              "receipt": "<set>",
              "settlement": null,
              "telemetry": null,
            },
          },
          "sessionId": "<session>",
          "userId": "<user>",
        },
      ],
    }
  `);
});

test("resumeSalaamWork: a gone session with no report is parked, then offered settlement again", async () => {
  const r = await newRun();
  await admitted(r);
  const logs = workLogs(r);
  try {
    const settleStoppedWork = async (id: string) => {
      await record(r, { settleStoppedWork: id });
      throw Error("not provable");
    };
    const d = deps(r, { ensure: "gone", deps: { settleStoppedWork, settlementRetryMs: 0 } });
    const first = await resumeSalaamWork(d);
    const second = await resumeSalaamWork(d);
    expect(await normalize(r, { first, second, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "parked",
            "reason": "Strict session ended before report intent; explicit original-run reconciliation required",
            "result": null,
          },
          "owner": {
            "receipt": "<set>",
            "settlement": null,
            "telemetry": null,
          },
        },
        "first": {
          "externalRunId": "<run>",
          "reason": "Strict session ended before report intent; explicit original-run reconciliation required",
          "status": "failed",
        },
        "second": null,
        "trace": [
          {
            "log": "salaam work: drive",
            "meta": {
              "agent": "<agent>",
              "run": "<run>",
              "session": "<session>",
            },
          },
          {
            "acp": "ensureStrictSession",
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "settleStoppedWork": "<run>",
          },
          {
            "log": "salaam work: stopped run not settled automatically",
            "meta": {
              "error": "Error: not provable",
              "run": "<run>",
            },
          },
          {
            "log": "salaam work: parked",
            "meta": {
              "reason": "Strict session ended before report intent; explicit original-run reconciliation required",
              "run": "<run>",
            },
          },
          {
            "board": "POST /runs/<run>/activities",
            "body": {
              "body": "This run's session ended before it could report (its work stopped). It needs operator review; nothing was completed or settled automatically.",
              "leaseEpoch": 1,
              "type": "thought",
            },
            "ledger": {
              "dispatch": {
                "outcome": "parked",
                "reason": "Strict session ended before report intent; explicit original-run reconciliation required",
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
          },
          {
            "settleStoppedWork": "<run>",
          },
          {
            "log": "salaam work: stopped run not settled automatically",
            "meta": {
              "error": "Error: not provable",
              "run": "<run>",
            },
          },
        ],
      }
    `);
  } finally {
    logs.mockRestore();
  }
});

test("resumeSalaamWork: a gone session whose stop is provable is settled, and the card told", async () => {
  const r = await newRun();
  await admitted(r);
  const logs = workLogs(r);
  try {
    const settleStoppedWork = async (id: string) => {
      await record(r, { settleStoppedWork: id });
    };
    const result = await resumeSalaamWork(deps(r, { ensure: "gone", deps: { settleStoppedWork } }));
    expect(await normalize(r, { result, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "working",
            "reason": null,
            "result": null,
          },
          "owner": {
            "receipt": "<set>",
            "settlement": null,
            "telemetry": null,
          },
        },
        "result": {
          "externalRunId": "<run>",
          "reason": "Stopped run settled with its known effects preserved",
          "status": "failed",
        },
        "trace": [
          {
            "log": "salaam work: drive",
            "meta": {
              "agent": "<agent>",
              "run": "<run>",
              "session": "<session>",
            },
          },
          {
            "acp": "ensureStrictSession",
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
            "sessionId": "<session>",
            "userId": "<user>",
          },
          {
            "settleStoppedWork": "<run>",
          },
          {
            "log": "salaam work: stopped run settled",
            "meta": {
              "run": "<run>",
            },
          },
          {
            "board": "POST /runs/<run>/activities",
            "body": {
              "body": "This run stopped before it could finish. Salaam checked what it had changed and kept it, and the run was retired as not completed, so the card can be run again.",
              "leaseEpoch": 1,
              "type": "thought",
            },
          },
        ],
      }
    `);
  } finally {
    logs.mockRestore();
  }
});

test("resumeSalaamWork: a revoked run with no report is parked from the resume itself", async () => {
  const r = await newRun();
  await admitted(r);
  await revoke(r);
  const logs = workLogs(r);
  try {
    const d = deps(r, { deps: { settleStoppedWork: refuseSettlement } });
    const result = await resumeSalaamWork(d);
    const again = await resumeSalaamWork(d);
    expect(await normalize(r, { result, again, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "parked",
            "reason": "Execution revoked before report intent; explicit original-run reconciliation required",
            "result": null,
          },
          "owner": {
            "receipt": "<set>",
            "settlement": null,
            "telemetry": null,
          },
        },
        "again": null,
        "result": {
          "externalRunId": "<run>",
          "reason": "Execution revoked before report intent; explicit original-run reconciliation required",
          "status": "failed",
        },
        "trace": [
          {
            "log": "salaam work: stopped run not settled automatically",
            "meta": {
              "error": "Error: no proof",
              "run": "<run>",
            },
          },
          {
            "log": "salaam work: parked",
            "meta": {
              "reason": "Execution revoked before report intent; explicit original-run reconciliation required",
              "run": "<run>",
            },
          },
          {
            "board": "POST /runs/<run>/activities",
            "body": {
              "body": "This run stopped before it could report (its execution was revoked). It needs operator reconciliation; nothing was completed or settled automatically.",
              "leaseEpoch": 1,
              "type": "thought",
            },
            "ledger": {
              "dispatch": {
                "outcome": "parked",
                "reason": "Execution revoked before report intent; explicit original-run reconciliation required",
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
          },
        ],
      }
    `);
  } finally {
    logs.mockRestore();
  }
});

test("resumeSalaamWork: two owners for one agent need reconciliation", async () => {
  const r = await newRun();
  await admitted(r);
  await revoke(r);
  const other = await newRun();
  other.station = r.station;
  other.boardId = r.boardId;
  other.agentKey = r.agentKey;
  await admitted(other);
  const result = await resumeSalaamWork(deps(r));
  expect(await normalize(r, { result, trace: r.trace })).toMatchInlineSnapshot(`
    {
      "result": {
        "reason": "Multiple strict run owners require reconciliation",
        "status": "failed",
      },
      "trace": [],
    }
  `);
});

// ─── Settlements ────────────────────────────────────────────────────────────

/** A board that loses the reply to `fail`, after it has ended the run as crashed. */
function failEndsRun(r: Run, lost: boolean): Route {
  return (method, path) => {
    if (method !== "POST" || !path.endsWith("/fail")) return null;
    ended(r, "crashed");
    return lost ? { ok: false, error: "lost producer reply" } : { ok: true, data: {} };
  };
}

test("settleNeverDispatchedSalaamWork: the board fail, the daemon verb and each settlement write", async () => {
  const r = await newRun();
  const work = await admitted(r);
  const a = await stopSession(r);
  const request = crypto.randomUUID();
  const spy = nodeVerbs(r, (_verb, params) => ({
    ok: true,
    data: {
      version: 1, state: "cancelled", effects: "never_dispatched", request_id: request, work_request_id: work.requestId,
      session_id: a.sessionId, task_id: TASK, plan_revision: 1, binding_digest: a.digest,
      producer_terminal_digest: field(params, "producer_terminal_digest"),
    },
  }));
  try {
    const d = deps(r, { route: failEndsRun(r, true) });
    const refusals = [
      await settle(settleNeverDispatchedSalaamWork(d, r.runId, "not-a-uuid")),
      await settle(settleNeverDispatchedSalaamWork(d, r.runId, request, undefined, true, true)),
      await settle(settleNeverDispatchedSalaamWork(d, "run_missing", request)),
    ].map((x) => ("error" in x ? (x.error.includes("invalid_format") ? "<invalid uuid>" : x.error) : x));
    const outcome = await settle(settleNeverDispatchedSalaamWork(d, r.runId, request));
    expect(await normalize(r, { refusals, outcome, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "abandoned",
            "reason": "Explicit never-dispatched work cancellation verified",
            "result": null,
          },
          "owner": {
            "receipt": "<set>",
            "settlement": {
              "receipt": {
                "binding_digest": "<digest>",
                "effects": "never_dispatched",
                "plan_revision": 1,
                "producer_terminal_digest": "<digest>",
                "request_id": "<uuid>",
                "session_id": "<uuid>",
                "state": "cancelled",
                "task_id": "<task>",
                "version": 1,
                "work_request_id": "<work>",
              },
              "request_id": "<uuid>",
              "terminal": {
                "board_id": "<board>",
                "card_id": "<card>",
                "ended_at": "<time>",
                "lease_epoch": 1,
                "outcome": "crashed",
                "run_id": "<run>",
                "stage_key": "build",
                "status": "ended",
                "version": 1,
              },
              "version": 1,
            },
            "telemetry": null,
          },
        },
        "outcome": {
          "result": {
            "binding_digest": "<digest>",
            "effects": "never_dispatched",
            "plan_revision": 1,
            "producer_terminal_digest": "<digest>",
            "request_id": "<uuid>",
            "session_id": "<uuid>",
            "state": "cancelled",
            "task_id": "<task>",
            "version": 1,
            "work_request_id": "<work>",
          },
        },
        "refusals": [
          "<invalid uuid>",
          "Error: Conflicting terminal recovery modes",
          "Error: Exact stopped work owner required",
        ],
        "trace": [
          {
            "board": "GET /runs/<run>",
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": {
                  "receipt": null,
                  "request_id": "<uuid>",
                  "terminal": null,
                  "version": 1,
                },
                "telemetry": null,
              },
            },
          },
          {
            "board": "POST /runs/<run>/fail",
            "body": {
              "leaseEpoch": 1,
              "reason": "Operator cancelled never-dispatched stopped work",
            },
          },
          {
            "board": "GET /runs/<run>",
          },
          {
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": {
                  "receipt": null,
                  "request_id": "<uuid>",
                  "terminal": {
                    "board_id": "<board>",
                    "card_id": "<card>",
                    "ended_at": "<time>",
                    "lease_epoch": 1,
                    "outcome": "crashed",
                    "run_id": "<run>",
                    "stage_key": "build",
                    "status": "ended",
                    "version": 1,
                  },
                  "version": 1,
                },
                "telemetry": null,
              },
            },
            "node": "salaam.work-settle",
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
              "producer_terminal_digest": "<digest>",
              "request_id": "<uuid>",
              "work_request_id": "<work>",
            },
          },
        ],
      }
    `);
  } finally {
    spy.mockRestore();
  }
});

test("settleStoppedSalaamWork: Salaam's proof first, then the known-effects settlement", async () => {
  const r = await newRun();
  const work = await admitted(r);
  const a = await stopSession(r, ["interrupted"]);
  const spy = nodeVerbs(r, (verb, params) =>
    verb === "salaam.work-status"
      ? { ok: true, data: { work_request_id: work.requestId, settlement_ready: "known_effects_failure" } }
      : {
          ok: true,
          data: {
            version: 1, state: "cancelled", effects: "known_effects_preserved", evidence_digest: "a".repeat(64),
            request_id: field(params, "request_id"), work_request_id: work.requestId, session_id: a.sessionId,
            task_id: TASK, plan_revision: 1, binding_digest: a.digest,
            producer_terminal_digest: field(params, "producer_terminal_digest"),
          },
        },
  );
  try {
    const d = deps(r, { route: failEndsRun(r, false) });
    const outcome = await settle(settleStoppedSalaamWork(d, r.runId));
    const again = await settle(settleStoppedSalaamWork(d, r.runId));
    const none = await settle(settleStoppedSalaamWork(d, "run_missing"));
    expect(await normalize(r, { outcome, again, none, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
      {
        "after": {
          "dispatch": {
            "outcome": "abandoned",
            "reason": "Stopped failed work retired with known effects preserved",
            "result": null,
          },
          "owner": {
            "receipt": "<set>",
            "settlement": {
              "known_effects_failure": true,
              "receipt": {
                "binding_digest": "<digest>",
                "effects": "known_effects_preserved",
                "evidence_digest": "<digest>",
                "plan_revision": 1,
                "producer_terminal_digest": "<digest>",
                "request_id": "<uuid>",
                "session_id": "<uuid>",
                "state": "cancelled",
                "task_id": "<task>",
                "version": 1,
                "work_request_id": "<work>",
              },
              "request_id": "<uuid>",
              "terminal": {
                "board_id": "<board>",
                "card_id": "<card>",
                "ended_at": "<time>",
                "lease_epoch": 1,
                "outcome": "crashed",
                "run_id": "<run>",
                "stage_key": "build",
                "status": "ended",
                "version": 1,
              },
              "version": 1,
            },
            "telemetry": null,
          },
        },
        "again": {
          "error": "Error: A settlement is already in progress for this run",
        },
        "none": {
          "error": "Error: No strict work owner",
        },
        "outcome": {},
        "trace": [
          {
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": null,
                "telemetry": null,
              },
            },
            "node": "salaam.work-status",
            "opts": {
              "timeoutMs": 125000,
            },
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
            },
          },
          {
            "board": "GET /runs/<run>",
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": {
                  "known_effects_failure": true,
                  "receipt": null,
                  "request_id": "<uuid>",
                  "terminal": null,
                  "version": 1,
                },
                "telemetry": null,
              },
            },
          },
          {
            "board": "POST /runs/<run>/fail",
            "body": {
              "leaseEpoch": 1,
              "reason": "Operator retired stopped failed work with known effects preserved",
            },
          },
          {
            "board": "GET /runs/<run>",
          },
          {
            "ledger": {
              "dispatch": {
                "outcome": "working",
                "reason": null,
                "result": null,
              },
              "owner": {
                "receipt": "<set>",
                "settlement": {
                  "known_effects_failure": true,
                  "receipt": null,
                  "request_id": "<uuid>",
                  "terminal": {
                    "board_id": "<board>",
                    "card_id": "<card>",
                    "ended_at": "<time>",
                    "lease_epoch": 1,
                    "outcome": "crashed",
                    "run_id": "<run>",
                    "stage_key": "build",
                    "status": "ended",
                    "version": 1,
                  },
                  "version": 1,
                },
                "telemetry": null,
              },
            },
            "node": "salaam.work-fail",
            "params": {
              "binding": {
                "hub_session_id": "<session>",
                "node_id": "<node>",
                "occupancy_epoch": 1,
                "organization_id": "<org>",
                "principal_id": "<principal>",
                "run": {
                  "epoch": 1,
                  "id": "<run>",
                  "source": "superpipeline",
                },
                "station_id": "<station>",
                "station_key": "<station-key>",
                "version": 1,
                "workspace": "/workspace",
              },
              "producer_terminal_digest": "<digest>",
              "request_id": "<uuid>",
              "work_request_id": "<work>",
            },
          },
        ],
      }
    `);
  } finally {
    spy.mockRestore();
  }
});

test("recoverExpiredSalaamDecision: nothing to recover without an owner or an expired offer", async () => {
  const r = await newRun();
  await admitted(r);
  const d = deps(r);
  const out = [
    await recoverExpiredSalaamDecision(d, "acps_none"),
    await recoverExpiredSalaamDecision(d, must(r.sessionId, "the session")),
  ];
  expect(await normalize(r, { out, trace: r.trace })).toMatchInlineSnapshot(`
    {
      "out": [
        null,
        null,
      ],
      "trace": [],
    }
  `);
});

test("reconcileUnopenedSalaamRelease: a confirmed release with no session writes released", async () => {
  const r = await newRun();
  await openRunDispatch(r);
  r.live = { ...r.live, run: { ...r.live.run, status: "ended", outcome: "released" } };
  const d = deps(r);
  const out = [
    await reconcileUnopenedSalaamRelease(d, r.runId, "build"),
    await reconcileUnopenedSalaamRelease(d, r.runId, "build"),
  ];
  expect(await normalize(r, { out, trace: r.trace, after: await ledger(r) })).toMatchInlineSnapshot(`
    {
      "after": {
        "dispatch": {
          "outcome": "released",
          "reason": "Original producer run confirms release before execution ownership",
          "result": null,
        },
        "owner": null,
      },
      "out": [
        true,
        false,
      ],
      "trace": [
        {
          "board": "GET /runs/<run>",
          "ledger": {
            "dispatch": {
              "outcome": "working",
              "reason": null,
              "result": null,
            },
            "owner": null,
          },
        },
      ],
    }
  `);
});
