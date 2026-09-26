import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { adminMiddleware } from "../../src/auth/admin-middleware";
import { getAllSettings } from "../../src/models/system-settings";
import {
  adminTranscriptionRoutes,
  stationTranscriptionRoutes,
} from "../../src/routes/transcription-settings";
import {
  createTranscriptionSettings,
  dbTranscriptionStore,
  TRANSCRIPTION_SETTING_KEY,
} from "../../src/services/transcription-settings";
import { encrypt, decrypt } from "../../src/utils/encryption";

/**
 * Transcription settings against Postgres: the hub default in one
 * `system_settings` row, a station's override in `station_transcription`, the
 * admin guard that production mounts the admin routes behind, and station
 * ownership read from the stations table.
 *
 * A fresh service instance (so a fresh cache) over the real store, with an
 * empty env, so nothing here depends on how the machine running it is set up.
 */

const KEY = "sk-test-not-a-real-key";
const ADMIN = "test-user-transcription-admin";
const OWNER = "test-user-transcription-owner";
const OTHER = "test-user-transcription-other";
const NODE = "node_transcription_settings";
const STATION = "station_transcription_a";

const settings = createTranscriptionSettings({ store: dbTranscriptionStore, env: {}, cipher: { encrypt, decrypt } });

function as(userId: string) {
  return async (c: any, next: () => Promise<void>) => {
    c.set("user", { id: userId, role: "user" });
    await next();
  };
}

/** The admin routes behind the real admin guard, which reads the role from the DB. */
function adminApp(userId: string) {
  return new Hono()
    .use("*", as(userId))
    .use("*", adminMiddleware)
    .route("/settings/transcription", adminTranscriptionRoutes({ settings, audit: async () => {} }));
}

function stationApp(userId: string) {
  return new Hono().use("*", as(userId)).route("/api", stationTranscriptionRoutes({ settings }));
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

let savedHubRow: { value: string } | undefined;

beforeAll(async () => {
  await ensurePgMigrations();
  // This file owns the hub-wide row while it runs; put back whatever was there.
  [savedHubRow] = (await rawSql`SELECT value FROM system_settings WHERE key = ${TRANSCRIPTION_SETTING_KEY}`) as any;
  await createTestUser({ id: ADMIN, email: "transcription-admin@example.com", name: "TA", role: "admin" });
  await createTestUser({ id: OWNER, email: "transcription-owner@example.com", name: "TO" });
  await createTestUser({ id: OTHER, email: "transcription-other@example.com", name: "TX" });
  const tenant = await resolveTenantForUser(OWNER);
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, 'transcription-box', 'tb', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
    VALUES (${STATION}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:t', 'leaf', 't', '["acp"]'::jsonb, now(), now())`;
});

beforeEach(async () => {
  await rawSql`DELETE FROM system_settings WHERE key = ${TRANSCRIPTION_SETTING_KEY}`;
  await rawSql`DELETE FROM station_transcription WHERE station_id = ${STATION}`;
  settings.invalidate();
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM system_settings WHERE key = ${TRANSCRIPTION_SETTING_KEY}`;
    if (savedHubRow) {
      await rawSql`INSERT INTO system_settings (key, value, updated_at) VALUES (${TRANSCRIPTION_SETTING_KEY}, ${savedHubRow.value}, now())`;
    }
    await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id IN (${ADMIN}, ${OWNER}, ${OTHER})`;
  } catch {
    // cleanup only
  }
});

describe("admin routes", () => {
  test("refuse a non-admin", async () => {
    expect((await adminApp(OWNER).request("/settings/transcription")).status).toBe(403);
    expect(
      (
        await adminApp(OWNER).request(
          "/settings/transcription",
          json("PUT", { enabled: true, url: "http://evil", model: "m", maxSeconds: 300 })
        )
      ).status
    ).toBe(403);
    expect((await adminApp(OWNER).request("/settings/transcription/test", json("POST", {}))).status).toBe(403);
  });

  test("an admin saves one row, with the key encrypted, and reads it back without the key", async () => {
    const put = await adminApp(ADMIN).request(
      "/settings/transcription",
      json("PUT", { enabled: true, url: "https://api.groq.com/openai", model: "whisper-large-v3-turbo", maxSeconds: 120, apiKey: KEY })
    );
    expect(put.status).toBe(200);

    const rows = (await rawSql`SELECT value FROM system_settings WHERE key = ${TRANSCRIPTION_SETTING_KEY}`) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].value).not.toContain(KEY);
    const stored = JSON.parse(rows[0].value);
    expect(await decrypt(stored.apiKeyEncrypted)).toBe(KEY);

    const get = await adminApp(ADMIN).request("/settings/transcription");
    const text = await get.text();
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(stored.apiKeyEncrypted);
    expect(JSON.parse(text)).toEqual({
      enabled: true,
      url: "https://api.groq.com/openai",
      model: "whisper-large-v3-turbo",
      maxSeconds: 120,
      hasApiKey: true,
      source: "settings",
    });
  });

  test("the generic settings dump does not carry the transcription row", async () => {
    await settings.putHub({ enabled: true, url: "http://t", model: "m", maxSeconds: 300, apiKey: KEY });
    const all = await getAllSettings();
    expect(all[TRANSCRIPTION_SETTING_KEY]).toBeUndefined();
  });
});

describe("station routes", () => {
  test("the owner sets a custom service; it is stored encrypted and resolves for that station", async () => {
    const res = await stationApp(OWNER).request(
      `/api/stations/${STATION}/transcription`,
      json("PUT", { mode: "custom", url: "https://api.openai.com", model: "whisper-1", maxSeconds: 60, apiKey: KEY })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(KEY);

    const [row] = (await rawSql`SELECT mode, api_key_encrypted FROM station_transcription WHERE station_id = ${STATION}`) as any[];
    expect(row.mode).toBe("custom");
    expect(row.api_key_encrypted).not.toContain(KEY);

    expect(await settings.resolveFor(STATION)).toEqual({
      url: "https://api.openai.com",
      apiKey: KEY,
      model: "whisper-1",
      maxSeconds: 60,
      source: "station",
    });
  });

  test("precedence over the real store: station off beats a hub setting", async () => {
    await settings.putHub({ enabled: true, url: "http://hub", model: "m", maxSeconds: 300 });
    expect((await settings.resolveFor(STATION))?.source).toBe("hub");
    await settings.putStation(STATION, { mode: "off" });
    expect(await settings.resolveFor(STATION)).toBeNull();
  });

  test("another user's station is a 404", async () => {
    expect((await stationApp(OTHER).request(`/api/stations/${STATION}/transcription`)).status).toBe(404);
    expect(
      (await stationApp(OTHER).request(`/api/stations/${STATION}/transcription`, json("PUT", { mode: "off" }))).status
    ).toBe(404);
    const rows = (await rawSql`SELECT 1 FROM station_transcription WHERE station_id = ${STATION}`) as any[];
    expect(rows).toHaveLength(0);
  });

  test("removing the station removes its setting", async () => {
    const tenant = await resolveTenantForUser(OWNER);
    const doomed = "station_transcription_doomed";
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${doomed}, ${tenant}, ${OWNER}, ${NODE}, 'openclaw', 'openclaw:d', 'leaf', 'd', '["acp"]'::jsonb, now(), now())`;
    await settings.putStation(doomed, { mode: "off" });
    await rawSql`DELETE FROM stations WHERE id = ${doomed}`;
    const rows = (await rawSql`SELECT 1 FROM station_transcription WHERE station_id = ${doomed}`) as any[];
    expect(rows).toHaveLength(0);
  });
});
