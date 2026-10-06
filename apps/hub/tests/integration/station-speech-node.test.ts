/**
 * Route test: POST /api/nodes/:nodeId/stations/:stationId/speech
 *
 * A node reading its station's resolved spoken-reply setting, so it can write
 * it into a harness profile (`speech.apply`). Authenticated exactly like the
 * transcription endpoint (and the matrix-credential one it copies) —
 * `Bearer <nodeId>:<nodeSecret>`, the credential must verify for the node the
 * path names, and a station that does not exist is refused exactly like one
 * hosted elsewhere (403). Not single-use: a read of current config.
 *
 * The real node credential and stations table are used; the resolver is
 * injected so the test controls the setting without touching the settings
 * tables (speech-settings.test.ts covers precedence).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";

import { db, rawSql } from "../../src/db/drizzle";
import { stations } from "../../src/db/schema/stations";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import { createNodeSpeechRoutes } from "../../src/routes/station-speech-node";
import type { ResolvedSpeech } from "../../src/services/speech-settings";

const RUN = crypto.randomUUID().slice(0, 8);
const TEST_USER = `test-user-station-speech-node-${RUN}`;
const KEY = "sk-node-speech-secret";

let nodeId: string;
let nodeSecret: string;
let otherNodeId: string;
let otherNodeSecret: string;
let stationId: string;
let otherNodesStation: string;

const resolved = new Map<string, ResolvedSpeech | null>();
const logLines: string[] = [];

function app() {
  return new Hono().route(
    "/api",
    createNodeSpeechRoutes({
      resolve: async (id) => resolved.get(id) ?? null,
      log: (line) => logLines.push(line),
    })
  );
}

function post(path: string, auth?: string) {
  return app().request(path, {
    method: "POST",
    headers: auth === undefined ? {} : { Authorization: auth },
  });
}

const url = (n = nodeId, s = stationId) => `/api/nodes/${n}/stations/${s}/speech`;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: `station-speech-node-${RUN}@example.com`,
    name: "Station Speech Node Test User",
  });
  const { token } = await mintEnrollmentToken(TEST_USER);
  ({ nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `station-speech-node-host-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  }));
  const { token: otherToken } = await mintEnrollmentToken(TEST_USER);
  ({ nodeId: otherNodeId, nodeSecret: otherNodeSecret } = await enrollNode(otherToken, {
    hostname: `station-speech-node-other-${RUN}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  }));

  stationId = `st_ssn_${RUN}`;
  otherNodesStation = `st_ssn_other_${RUN}`;
  await db.insert(stations).values([
    {
      id: stationId,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: TEST_USER,
      nodeId,
      harness: "hermes",
      stationKey: "hermes:analyst-echo",
      kind: "composite",
      displayName: "analyst-echo",
      matrixIdentityMode: "harness",
    },
    {
      id: otherNodesStation,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId: TEST_USER,
      nodeId: otherNodeId,
      harness: "hermes",
      stationKey: "hermes:elsewhere",
      kind: "composite",
      displayName: "elsewhere",
    },
  ]);
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await deleteTestUser(TEST_USER);
  } catch {
    // cleanup only
  }
});

describe("POST /api/nodes/:nodeId/stations/:stationId/speech", () => {
  test("no credential → 401", async () => {
    expect((await post(url())).status).toBe(401);
  });

  test("a wrong secret → 401", async () => {
    expect((await post(url(), `Bearer ${nodeId}:not-the-secret`)).status).toBe(401);
  });

  test("a credential for a different node than the path names → 401", async () => {
    expect((await post(url(), `Bearer ${otherNodeId}:${otherNodeSecret}`)).status).toBe(401);
  });

  test("a station hosted by another node → 403", async () => {
    const res = await post(url(nodeId, otherNodesStation), `Bearer ${nodeId}:${nodeSecret}`);
    expect(res.status).toBe(403);
  });

  test("an unknown station → 403, identical to one hosted elsewhere", async () => {
    const res = await post(url(nodeId, `st_nope_${RUN}`), `Bearer ${nodeId}:${nodeSecret}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "station not hosted by this node" });
  });

  test("a resolved setting comes back with its key, voice and speak mode; asking twice answers twice", async () => {
    resolved.set(stationId, {
      url: "http://100.78.52.87:8841",
      apiKey: KEY,
      voice: "af_heart:60+af_bella:40",
      voiceSource: "station",
      speakMode: "voice_in",
      maxChars: 1500,
      source: "hub",
    });
    for (let i = 0; i < 2; i++) {
      const res = await post(url(), `Bearer ${nodeId}:${nodeSecret}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        enabled: true,
        url: "http://100.78.52.87:8841",
        apiKey: KEY,
        voice: "af_heart:60+af_bella:40",
        speakMode: "voice_in",
      });
    }
    expect(logLines.length).toBeGreaterThan(0);
    expect(logLines.join("\n")).not.toContain(KEY);
    expect(logLines.join("\n")).toContain("af_heart:60+af_bella:40");
  });

  test("a refused request never reaches the resolver", async () => {
    let asked = 0;
    const counting = new Hono().route(
      "/api",
      createNodeSpeechRoutes({
        resolve: async () => {
          asked++;
          return null;
        },
      })
    );
    const res = await counting.request(url(), { method: "POST", headers: { Authorization: `Bearer ${nodeId}:nope` } });
    expect(res.status).toBe(401);
    const res2 = await counting.request(url(nodeId, otherNodesStation), {
      method: "POST",
      headers: { Authorization: `Bearer ${nodeId}:${nodeSecret}` },
    });
    expect(res2.status).toBe(403);
    expect(asked).toBe(0);
  });

  test("a station with no speech service (off, or none anywhere) → enabled:false", async () => {
    resolved.set(stationId, null);
    const res = await post(url(), `Bearer ${nodeId}:${nodeSecret}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
});
