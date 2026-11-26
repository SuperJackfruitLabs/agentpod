import { describe, expect, test } from "bun:test";
import { createCallDeviceProvisioner, type CallDeviceStore } from "./call-device";

/**
 * The agent's call device: a second Matrix device of the agent user, `SUPERDIAL`, which
 * superdial-agent joins calls as. Minted once by appservice login, kept, and reused — a second
 * login with the same device id would invalidate the token superdial-agent already holds.
 *
 * It must never disturb the hub's own device: no logout, and nothing written where the hub
 * keeps its device id (`<store>/<localpart>/device`).
 */

const HS = "http://hs.test";
const AGENT = "@agent_ada:id.agentpod.dev";

function memoryStore(): CallDeviceStore & { rows: Map<string, { deviceId: string; accessToken: string }> } {
  const rows = new Map<string, { deviceId: string; accessToken: string }>();
  return {
    rows,
    get: async (agent) => rows.get(agent) ?? null,
    put: async (agent, device) => void rows.set(agent, device),
  };
}

function homeserver(answer: (n: number) => { status: number; body: Record<string, unknown> }) {
  const calls: Array<{ url: string; method: string; body: unknown; auth: string | null }> = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: new Headers(init?.headers).get("Authorization"),
    });
    const { status, body } = answer(calls.length);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const ok = () => ({ status: 200, body: { user_id: AGENT, device_id: "SUPERDIAL", access_token: "syt_call_token" } });

describe("the agent's call device", () => {
  test("the first ask logs in once, as the agent, with device_id SUPERDIAL, and logs nothing out", async () => {
    const store = memoryStore();
    const hs = homeserver(ok);
    const deviceFor = createCallDeviceProvisioner({ homeserverUrl: HS, asToken: "as_token", store, fetch: hs.fetch });

    expect(await deviceFor(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_call_token" });
    expect(hs.calls).toHaveLength(1);
    const [login] = hs.calls;
    expect(login?.url).toBe(`${HS}/_matrix/client/v3/login`);
    expect(login?.method).toBe("POST");
    expect(login?.auth).toBe("Bearer as_token");
    expect(login?.body).toEqual({
      type: "m.login.application_service",
      identifier: { type: "m.id.user", user: "agent_ada" },
      device_id: "SUPERDIAL",
      initial_device_display_name: "superdial call",
    });
    expect(hs.calls.some((c) => c.url.includes("logout"))).toBe(false);
    expect(store.rows.get(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_call_token" });
  });

  test("it is reused: by the same provisioner, and by a fresh one over the same store", async () => {
    const store = memoryStore();
    const hs = homeserver(ok);
    const first = createCallDeviceProvisioner({ homeserverUrl: HS, asToken: "as_token", store, fetch: hs.fetch });
    await first(AGENT);
    await first(AGENT);
    const afterRestart = createCallDeviceProvisioner({ homeserverUrl: HS, asToken: "as_token", store, fetch: hs.fetch });
    expect(await afterRestart(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_call_token" });
    expect(hs.calls).toHaveLength(1);
  });

  test("a failed login is not kept as the answer", async () => {
    const store = memoryStore();
    const hs = homeserver((n) => (n === 1 ? { status: 502, body: { errcode: "M_UNKNOWN" } } : ok()));
    const deviceFor = createCallDeviceProvisioner({ homeserverUrl: HS, asToken: "as_token", store, fetch: hs.fetch });
    await expect(deviceFor(AGENT)).rejects.toThrow(/502/);
    expect(store.rows.size).toBe(0);
    expect(await deviceFor(AGENT)).toEqual({ deviceId: "SUPERDIAL", accessToken: "syt_call_token" });
  });

  test("a login that hands back another device, or no token, is refused", async () => {
    for (const body of [
      { user_id: AGENT, device_id: "OTHER", access_token: "t" },
      { user_id: AGENT, device_id: "SUPERDIAL" },
    ]) {
      const store = memoryStore();
      const hs = homeserver(() => ({ status: 200, body }));
      const deviceFor = createCallDeviceProvisioner({ homeserverUrl: HS, asToken: "as_token", store, fetch: hs.fetch });
      await expect(deviceFor(AGENT)).rejects.toThrow();
      expect(store.rows.size).toBe(0);
    }
  });
});
