/**
 * The agent's call device token, at rest.
 *
 * It is a live Matrix access token for the agent user, so it is stored the way the hub stores its
 * other secrets: encrypted with ENCRYPTION_KEY (`utils/encryption.ts`), never in the clear.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { rawSql } from "../../src/db/drizzle";
import { dbCallDeviceStore } from "../../src/services/matrix-as/call-device";

const AGENT = "@agent_superdial-it:id.agentpod.dev";

beforeAll(async () => {
  await ensurePgMigrations();
  await rawSql`DELETE FROM superdial_call_devices WHERE agent_user_id = ${AGENT}`;
});

afterAll(async () => {
  await rawSql`DELETE FROM superdial_call_devices WHERE agent_user_id = ${AGENT}`;
});

describe("the call device store", () => {
  test("nothing is stored for an agent that has no call device", async () => {
    expect(await dbCallDeviceStore.get(AGENT)).toBeNull();
  });

  test("a device round-trips, and its token is not readable in the table", async () => {
    await dbCallDeviceStore.put(AGENT, { deviceId: "SUPERDIAL", accessToken: "syt_plain_call_token" });
    expect(await dbCallDeviceStore.get(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_plain_call_token" });

    const rows = await rawSql`SELECT device_id, access_token_encrypted FROM superdial_call_devices WHERE agent_user_id = ${AGENT}`;
    expect(rows).toHaveLength(1);
    const [row] = rows as unknown as Array<{ device_id: string; access_token_encrypted: string }>;
    expect(row?.device_id).toBe("SUPERDIAL");
    expect(String(row?.access_token_encrypted)).not.toContain("syt_plain_call_token");
    expect(String(row?.access_token_encrypted).length).toBeGreaterThan(0);
  });

  test("a second put replaces the first (a re-mint after the token was lost)", async () => {
    await dbCallDeviceStore.put(AGENT, { deviceId: "SUPERDIAL", accessToken: "syt_second" });
    expect(await dbCallDeviceStore.get(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_second" });
  });
});
