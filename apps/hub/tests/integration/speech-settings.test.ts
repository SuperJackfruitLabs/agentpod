import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { adminMiddleware } from "../../src/auth/admin-middleware";
import { authMiddleware } from "../../src/auth/middleware";
import { getAllSettings } from "../../src/models/system-settings";
import { adminSpeechRoutes, speechVoicesRoutes, stationSpeechRoutes } from "../../src/routes/speech-settings";
import {
  assignedVoiceFor,
  createSpeechSettings,
  dbSpeechStore,
  SPEECH_SETTING_KEY,
} from "../../src/services/speech-settings";
import { stationForRoom } from "../../src/services/matrix-as/stations";
import { TENANT_SCOPED_TABLES } from "../../src/db/tenant-scope";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * Speech settings against Postgres: the hub default in one `system_settings`
 * row, a station's voice and override in `station_speech`, the admin guard,
 * ownership from the stations table, the voices proxy behind the hub's real
 * auth, and the room → station lookup the voice replier makes.
 */

const KEY = "sk-test-not-a-real-key";
const ADMIN = "test-user-speech-admin";
const OWNER = "test-user-speech-owner";
const OTHER = "test-user-speech-other";
const NODE = "node_speech_settings";
const STATION = "station_speech_a";
const HARNESS_STATION = "station_speech_h";
const ROOM = "!speech-room:id.agentpod.dev";
const HARNESS_ROOM = "!speech-room-h:id.agentpod.dev";

const settings = createSpeechSettings({ store: dbSpeechStore, env: {}, cipher: { encrypt, decrypt } });

function as(userId: string) {
  return async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: userId, role: "user" });
    await next();
  };
}

function adminApp(userId: string) {
  return new Hono()
    .use("*", as(userId))
    .use("*", adminMiddleware)
    .route("/settings/speech", adminSpeechRoutes({ settings, audit: async () => {} }));
}

function stationApp(userId: string) {
  return new Hono().use("*", as(userId)).route("/api", stationSpeechRoutes({ settings }));
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const HUB = { enabled: true, url: "http://speech.test:8841", defaultVoice: "", mode: "voice_in" as const, maxChars: 1500 };

let savedHubRow: { value: string } | undefined;

beforeAll(async () => {
  await ensurePgMigrations();
  [savedHubRow] = (await rawSql`SELECT value FROM system_settings WHERE key = ${SPEECH_SETTING_KEY}`) as any;
  await createTestUser({ id: ADMIN, email: "speech-admin@example.com", name: "SA", role: "admin" });
  await createTestUser({ id: OWNER, email: "speech-owner@example.com", name: "SO" });
  await createTestUser({ id: OTHER, email: "speech-other@example.com", name: "SX" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM matrix_rooms WHERE room_id IN (${ROOM}, ${HARNESS_ROOM})`;
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'speech-box', 'sb', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'claude-code', 'claude-code:s', 'leaf', 's', '["acp"]'::jsonb, now(), now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at, matrix_identity_mode)
    VALUES (${HARNESS_STATION}, ${tenant}, ${OWNER}, ${NODE}, 'hermes', 'hermes:h', 'leaf', 'h', '["acp"]'::jsonb, now(), now(), 'harness')`;
  await rawSql`
    INSERT INTO matrix_rooms (room_id, tenant_id, station_id, alias, created_at)
    VALUES (${ROOM}, ${tenant}, ${STATION}, '#speech_a:id.agentpod.dev', now()),
           (${HARNESS_ROOM}, ${tenant}, ${HARNESS_STATION}, '#speech_h:id.agentpod.dev', now())`;
});

beforeEach(async () => {
  await rawSql`DELETE FROM system_settings WHERE key = ${SPEECH_SETTING_KEY}`;
  await rawSql`DELETE FROM station_speech WHERE station_id IN (${STATION}, ${HARNESS_STATION})`;
  settings.invalidate();
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM system_settings WHERE key = ${SPEECH_SETTING_KEY}`;
    if (savedHubRow) {
      await rawSql`INSERT INTO system_settings (key, value, updated_at) VALUES (${SPEECH_SETTING_KEY}, ${savedHubRow.value}, now())`;
    }
    await rawSql`DELETE FROM matrix_rooms WHERE room_id IN (${ROOM}, ${HARNESS_ROOM})`;
    await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id IN (${ADMIN}, ${OWNER}, ${OTHER})`;
  } catch {
    // cleanup only
  }
});

describe("admin routes", () => {
  test("refuse a non-admin", async () => {
    expect((await adminApp(OWNER).request("/settings/speech")).status).toBe(403);
    expect((await adminApp(OWNER).request("/settings/speech", json("PUT", HUB))).status).toBe(403);
    expect((await adminApp(OWNER).request("/settings/speech/test", json("POST", {}))).status).toBe(403);
  });

  test("an admin saves one row, the key encrypted, and reads it back without the key", async () => {
    const put = await adminApp(ADMIN).request("/settings/speech", json("PUT", { ...HUB, apiKey: KEY }));
    expect(put.status).toBe(200);
    const rows = (await rawSql`SELECT value FROM system_settings WHERE key = ${SPEECH_SETTING_KEY}`) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].value).not.toContain(KEY);
    const stored = JSON.parse(rows[0].value);
    expect(await decrypt(stored.apiKeyEncrypted)).toBe(KEY);

    const text = await (await adminApp(ADMIN).request("/settings/speech")).text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(stored.apiKeyEncrypted);
    expect(JSON.parse(text)).toMatchObject({ enabled: true, hasApiKey: true, source: "settings", mode: "voice_in" });
  });

  test("the generic settings dump does not carry the speech row", async () => {
    await settings.putHub({ ...HUB, apiKey: KEY });
    expect((await getAllSettings())[SPEECH_SETTING_KEY]).toBeUndefined();
  });
});

describe("station routes", () => {
  test("the owner picks a voice; it is stored and resolves for that station, with the hub's service", async () => {
    await settings.putHub({ ...HUB, apiKey: KEY });
    const res = await stationApp(OWNER).request(
      `/api/stations/${STATION}/speech`,
      json("PUT", { mode: "inherit", voice: "bm_george", speakMode: "always" })
    );
    expect(res.status).toBe(200);
    const [row] = (await rawSql`SELECT mode, voice, speak_mode, tenant_id FROM station_speech WHERE station_id = ${STATION}`) as any[];
    expect(row).toMatchObject({ mode: "inherit", voice: "bm_george", speak_mode: "always" });
    expect(row.tenant_id).toBe(await resolveTenantForUser(OWNER));
    expect(await settings.resolveFor(STATION)).toEqual({
      url: HUB.url,
      apiKey: KEY,
      voice: "bm_george",
      voiceSource: "station",
      speakMode: "always",
      maxChars: 1500,
      source: "hub",
    });
  });

  test("no voice chosen: the assigned one, the same on every read", async () => {
    await settings.putHub(HUB);
    const a = await settings.resolveFor(STATION);
    settings.invalidate();
    const b = await settings.resolveFor(STATION);
    expect(a?.voice).toBe(assignedVoiceFor(STATION));
    expect(b?.voice).toBe(a!.voice);
  });

  test("a custom key is stored encrypted and never returned", async () => {
    const res = await stationApp(OWNER).request(
      `/api/stations/${STATION}/speech`,
      json("PUT", { mode: "custom", url: "https://api.openai.com", apiKey: KEY })
    );
    expect(await res.text()).not.toContain(KEY);
    const [row] = (await rawSql`SELECT api_key_encrypted FROM station_speech WHERE station_id = ${STATION}`) as any[];
    expect(row.api_key_encrypted).not.toContain(KEY);
    expect((await settings.resolveFor(STATION))?.apiKey).toBe(KEY);
  });

  test("another user's station is a 404, and nothing is written", async () => {
    expect((await stationApp(OTHER).request(`/api/stations/${STATION}/speech`)).status).toBe(404);
    expect((await stationApp(OTHER).request(`/api/stations/${STATION}/speech`, json("PUT", { mode: "off" }))).status).toBe(404);
    expect((await rawSql`SELECT 1 FROM station_speech WHERE station_id = ${STATION}`) as any[]).toHaveLength(0);
  });

  test("a harness-mode station's voice is stored and editable now, for stage 3", async () => {
    const res = await stationApp(OWNER).request(
      `/api/stations/${HARNESS_STATION}/speech`,
      json("PUT", { mode: "inherit", voice: "af_nova" })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).effective).toMatchObject({ voice: "af_nova", voiceSource: "station" });
  });

  test("removing the station removes its setting; the table is tenant-scoped", async () => {
    expect(Object.values(TENANT_SCOPED_TABLES)).toContain((await import("../../src/db/schema/speech")).stationSpeech);
    const tenant = await resolveTenantForUser(OWNER);
    const doomed = "station_speech_doomed";
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${doomed}, ${tenant}, ${OWNER}, ${NODE}, 'pi', 'pi:d', 'leaf', 'd', '["acp"]'::jsonb, now(), now())`;
    await settings.putStation(doomed, { mode: "inherit", voice: "af_bella" });
    await rawSql`DELETE FROM stations WHERE id = ${doomed}`;
    expect((await rawSql`SELECT 1 FROM station_speech WHERE station_id = ${doomed}`) as any[]).toHaveLength(0);
  });
});

describe("the room → station lookup the voice replier makes", () => {
  test("bridge-mode and harness-mode rooms are told apart; an unknown room is null", async () => {
    expect(await stationForRoom(ROOM)).toEqual({ stationId: STATION, identityMode: "bridge" });
    expect(await stationForRoom(HARNESS_ROOM)).toEqual({ stationId: HARNESS_STATION, identityMode: "harness" });
    expect(await stationForRoom("!nope:id.agentpod.dev")).toBeNull();
  });
});

describe("the voices proxy behind the hub's real auth", () => {
  test("no session: 401, and the service is never asked", async () => {
    let asked = 0;
    const app = new Hono().use("/api/*", authMiddleware).route(
      "/api",
      speechVoicesRoutes({
        settings,
        fetch: (async () => {
          asked += 1;
          return Response.json({ voices: [] });
        }) as unknown as typeof fetch,
      })
    );
    await settings.putHub(HUB);
    expect((await app.request("/api/speech/voices")).status).toBe(401);
    expect((await app.request("/api/speech/voices/af_heart/preview")).status).toBe(401);
    expect(asked).toBe(0);
  });
});

describe("POST /api/stations/:id/speech/apply over the stations table", () => {
  const sent: Array<{ nodeId: string; verb: string; params: unknown }> = [];
  const APPLIED = { applied: true, mode: "on", voice: "af_heart", speakMode: "voice_in", autoSpeak: false, restarted: true };

  function applyApp(userId: string) {
    return new Hono().use("*", as(userId)).route(
      "/api",
      stationSpeechRoutes({
        settings,
        brokerRequest: async (nodeId, verb, params) => {
          sent.push({ nodeId, verb, params });
          return { ok: true, data: APPLIED };
        },
      })
    );
  }

  beforeEach(() => {
    sent.length = 0;
  });

  test("a harness-mode Hermes station's owner sends speech.apply to its node", async () => {
    const res = await applyApp(OWNER).request(`/api/stations/${HARNESS_STATION}/speech/apply`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(APPLIED);
    expect(sent).toEqual([{ nodeId: NODE, verb: "speech.apply", params: { key: "hermes:h", stationId: HARNESS_STATION } }]);
  });

  test("another user's station is a 404 and nothing is sent", async () => {
    const res = await applyApp(OTHER).request(`/api/stations/${HARNESS_STATION}/speech/apply`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });

  test("a bridge-mode station is a 400 and nothing is sent", async () => {
    const res = await applyApp(OWNER).request(`/api/stations/${STATION}/speech/apply`, { method: "POST" });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
