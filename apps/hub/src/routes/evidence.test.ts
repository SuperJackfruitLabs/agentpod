/**
 * Route tests: the hub's evidence routes (superwitness contract C5).
 * Uses the local Docker test-postgres (localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EvidenceAttemptResponse, EvidenceRunResponse } from "@agentpod/contract";

import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { auth } from "../auth/drizzle-auth";
import { buildTokenPayload } from "../auth/jwt-claims";
import { signServiceToken } from "../auth/service-signing";
import { db, rawSql } from "../db/drizzle";
import { acpSessions } from "../db/schema/acp";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { endAttempt, openDispatch, startAttempt } from "../services/bridge/ledger";
import { makeFingerprint } from "../services/evidence/fingerprint";
import { setGrant } from "../services/grants";
import { createPrincipal, suspendPrincipal } from "../services/principals";
import { createEvidenceRoutes } from "./evidence";

const RUN = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
const STATION = `station_${crypto.randomUUID()}`;
const SESSION = `acps_${crypto.randomUUID()}`;
const BOARD = "brd_9c1d4e5f6a7b8c9d";
const CARD = "card_1a2b3c4d5e6f7a8b";
const RUN_ID = `run_ev${RUN}`;
const BARE_RUN = `run_bare${RUN}`;
const FIXED_NOW = new Date("2026-10-04T10:20:00.000Z");
const app = createEvidenceRoutes({ now: () => FIXED_NOW });
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../../fixtures/evidence/hub_evidence_run.json"), "utf8"),
);

let reader = "";
let narrowed = "";
let suspended = "";
let firstAttempt = "";
let legacyAttempt = "";

const serviceToken = async (principalId: string) =>
  signServiceToken({ payload: await buildTokenPayload({ principalId }), subject: principalId, ttl: "5m" });
const get = (path: string, token?: string) =>
  app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

/** Object keys, recursively; scalars collapse so only the SHAPE is compared. */
function keyShape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [keyShape(v[0])] : [];
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, keyShape((v as Record<string, unknown>)[k])]));
  }
  return "scalar";
}

beforeAll(async () => {
  await ensurePgMigrations();
  const now = new Date();
  await db.insert(acpSessions).values({
    id: SESSION, tenantId: BOOTSTRAP_TENANT_ID, stationId: STATION, userId: "evidence-it", mode: "full-auto",
    status: "idle", lastSeq: 0, createdAt: now, lastEventAt: now,
  });
  const key = { tenantId: BOOTSTRAP_TENANT_ID, externalSource: "superpipeline", boardId: BOARD, externalCardId: CARD, externalRunId: RUN_ID };
  await openDispatch({ ...key, agentKey: "hermes-press", stationId: STATION, leaseEpoch: 1 });
  firstAttempt = await startAttempt({
    ...key, sessionId: SESSION, stationId: STATION, startSeq: 1,
    fingerprint: makeFingerprint({ harness: "hermes", profile: "press", skill_release: "none" }, "hub"),
  });
  await endAttempt(firstAttempt, "completed", 9);
  // A row as migration 0085 found it: no fingerprint at all.
  legacyAttempt = `attempt_${crypto.randomUUID()}`;
  await rawSql`INSERT INTO acp_runs (id, tenant_id, session_id, station_id, external_run_id, external_source, state, start_seq, started_at)
               VALUES (${legacyAttempt}, ${BOOTSTRAP_TENANT_ID}, ${SESSION}, ${STATION}, ${RUN_ID}, 'superpipeline', 'working', 10, now())`;
  // An attempt whose ledger row is gone.
  await rawSql`INSERT INTO acp_runs (id, tenant_id, session_id, station_id, external_run_id, external_source, state, start_seq, started_at)
               VALUES (${`attempt_${crypto.randomUUID()}`}, ${BOOTSTRAP_TENANT_ID}, ${SESSION}, ${STATION}, ${BARE_RUN}, 'superpipeline', 'working', 20, now())`;

  reader = await createPrincipal({ kind: "service", handle: `ev-reader-${RUN}` });
  await setGrant(reader, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
  narrowed = await createPrincipal({ kind: "service", handle: `ev-narrow-${RUN}` });
  await setGrant(narrowed, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
  suspended = await createPrincipal({ kind: "service", handle: `ev-susp-${RUN}` });
  await setGrant(suspended, { mayDispatch: [], mayGrantReach: false, scopes: ["evidence:read"] });
});

afterAll(async () => {
  await rawSql`DELETE FROM bridge_dispatches WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM acp_runs WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM acp_sessions WHERE station_id = ${STATION}`;
  await rawSql`DELETE FROM principals WHERE handle LIKE ${`ev-%-${RUN}`}`;
});

describe("GET /api/evidence/runs/:source/:externalRunId", () => {
  test("answers a granted service with the ledger entry and every attempt, in the fixture's shape", async () => {
    const res = await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, await serviceToken(reader));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(EvidenceRunResponse.safeParse(body).error).toBeUndefined();
    expect(keyShape(body)).toEqual(keyShape(fixture.examples[0].response));
    expect(body).toMatchObject({
      external_source: "superpipeline", external_run_id: RUN_ID, board_id: BOARD, card_id: CARD,
      dispatch: { outcome: "working", detail: null, station_id: STATION },
      as_of: FIXED_NOW.toISOString(),
    });
    expect(body.attempts.map((a: { id: string }) => a.id)).toEqual([firstAttempt, legacyAttempt]);
    expect(body.attempts[0]).toMatchObject({ state: "completed", start_seq: 1, end_seq: 9 });
    expect(body.attempts[0].fingerprint).toMatchObject({ harness: "hermes", profile: "press", reported_by: "hub" });
  });

  test("a pre-fingerprint attempt reads as unknown", async () => {
    const body = (await (await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, await serviceToken(reader))).json()) as any;
    expect(body.attempts[1].fingerprint).toEqual({
      digest: "unknown", harness: "unknown", harness_version: "unknown", model: "unknown",
      profile: "unknown", skill_release: "unknown", reported_by: "hub",
    });
  });

  test("attempts with no ledger row still answer, with the ledger fields null", async () => {
    const body = (await (await get(`/api/evidence/runs/superpipeline/${BARE_RUN}`, await serviceToken(reader))).json()) as any;
    expect(body).toMatchObject({ board_id: null, card_id: null, dispatch: null });
    expect(body.attempts).toHaveLength(1);
    expect(keyShape({ ...body, attempts: [] })).toEqual(keyShape(fixture.examples[1].response));
  });

  test("an unknown run, or a known run under another source, is 404 not_found", async () => {
    const t = await serviceToken(reader);
    for (const path of [`/api/evidence/runs/superpipeline/run_nothing${RUN}`, `/api/evidence/runs/other/${RUN_ID}`]) {
      const res = await get(path, t);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    }
  });

  test("no token, a foreign token or garbage is 401", async () => {
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`)).status).toBe(401);
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, "not.a.jwt")).status).toBe(401);
  });

  test("a principal without evidence:read is 403", async () => {
    const plain = await createPrincipal({ kind: "service", handle: `ev-plain-${RUN}` });
    const res = await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, await serviceToken(plain));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });

  test("revocation takes effect before the token expires", async () => {
    const t1 = await serviceToken(narrowed);
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, t1)).status).toBe(200);
    await setGrant(narrowed, { mayDispatch: [], mayGrantReach: false, scopes: [] });
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, t1)).status).toBe(403);

    const t2 = await serviceToken(suspended);
    await suspendPrincipal(suspended);
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, t2)).status).toBe(403);
  });

  test("rows are scoped to the token's tenant", async () => {
    const { token } = await auth.api.signJWT({
      body: {
        payload: {
          iat: Math.floor(Date.now() / 1000), sub: reader, principalKind: "service",
          tenant: "fleet_ffffffffffffffffffff", mayDispatch: [], mayGrantReach: false,
        },
      },
    });
    expect((await get(`/api/evidence/runs/superpipeline/${RUN_ID}`, token)).status).toBe(404);
  });
});

describe("GET /api/evidence/attempts/:attemptId", () => {
  test("resolves an attempt to its work run and board", async () => {
    const res = await get(`/api/evidence/attempts/${firstAttempt}`, await serviceToken(reader));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(EvidenceAttemptResponse.safeParse(body).error).toBeUndefined();
    expect(body).toEqual({ external_source: "superpipeline", external_run_id: RUN_ID, board_id: BOARD });
  });

  test("an unknown attempt is 404, and the same authorization applies", async () => {
    expect((await get(`/api/evidence/attempts/attempt_${crypto.randomUUID()}`, await serviceToken(reader))).status).toBe(404);
    expect((await get(`/api/evidence/attempts/${firstAttempt}`)).status).toBe(401);
  });
});

/** Where the routes are MOUNTED, which the bare-app tests above cannot see. */
describe("the evidence routes are mounted where they can be reached", () => {
  const source = readFileSync(join(import.meta.dir, "../index.ts"), "utf8");
  const mount = source.indexOf(".route('/', evidenceRoutes)");

  test("above authMiddleware, which would 401 a service token", () => {
    const middleware = source.indexOf(".use('/api/*', authMiddleware)");
    expect(mount, "evidenceRoutes is not mounted in index.ts at all").toBeGreaterThan(-1);
    expect(middleware).toBeGreaterThan(-1);
    expect(mount, "evidenceRoutes is behind authMiddleware").toBeLessThan(middleware);
  });
});
