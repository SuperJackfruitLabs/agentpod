/**
 * connection.svelte.test.ts
 *
 * TDD tests for the web-based connection store (fetch + localStorage).
 * Run RED first (current Tauri implementation fails in jsdom), then implement.
 */

import { vi, test, expect, beforeEach } from "vitest";

// Mock auth.svelte to avoid its Tauri/better-auth transitive imports
vi.mock("./auth.svelte", () => ({
  setAuthApiUrl: vi.fn(),
  clearAuthSession: vi.fn(),
}));

import { connect, disconnect, initConnection, connection } from "./connection.svelte";
import { setAuthApiUrl, clearAuthSession } from "./auth.svelte";

const LS_KEY = "agentpod.apiUrl";

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  localStorage.clear();
  // Reset connection state via disconnect so each test starts fresh
  await disconnect();
});

// ---------------------------------------------------------------------------
// connect() — success path
// ---------------------------------------------------------------------------

test("connect with ok:true → isConnected true, url stored in localStorage, setAuthApiUrl called", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

  const result = await connect("http://localhost:3001");

  expect(result).toBe(true);
  expect(connection.isConnected).toBe(true);
  expect(connection.apiUrl).toBe("http://localhost:3001");
  expect(localStorage.getItem(LS_KEY)).toBe("http://localhost:3001");
  expect(setAuthApiUrl).toHaveBeenCalledWith("http://localhost:3001");
});

test("connect strips trailing slash from apiUrl before probing /health", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);

  await connect("http://localhost:3001/");

  expect(fetchMock).toHaveBeenCalledWith("http://localhost:3001/health");
});

// ---------------------------------------------------------------------------
// connect() — failure paths
// ---------------------------------------------------------------------------

test("connect with ok:false → isConnected false, error set, localStorage not written", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

  const result = await connect("http://localhost:3001");

  expect(result).toBe(false);
  expect(connection.isConnected).toBe(false);
  expect(connection.error).toBeTruthy();
  expect(localStorage.getItem(LS_KEY)).toBeNull();
  expect(setAuthApiUrl).not.toHaveBeenCalled();
});

test("connect that throws → isConnected false, error set, localStorage not written", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

  const result = await connect("http://localhost:3001");

  expect(result).toBe(false);
  expect(connection.isConnected).toBe(false);
  expect(connection.error).toBe("network error");
  expect(localStorage.getItem(LS_KEY)).toBeNull();
});

// ---------------------------------------------------------------------------
// disconnect()
// ---------------------------------------------------------------------------

test("disconnect → clears localStorage and resets isConnected to false", async () => {
  // Establish a connection first
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  await connect("http://localhost:3001");
  expect(connection.isConnected).toBe(true);
  expect(localStorage.getItem(LS_KEY)).toBe("http://localhost:3001");

  await disconnect();

  expect(connection.isConnected).toBe(false);
  expect(connection.apiUrl).toBeNull();
  expect(localStorage.getItem(LS_KEY)).toBeNull();
});

test("disconnect → clears the auth session (no stale identity on server switch)", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  await connect("http://localhost:3001");

  // clear the call made by the beforeEach disconnect, then assert this one
  vi.mocked(clearAuthSession).mockClear();
  await disconnect();

  expect(clearAuthSession).toHaveBeenCalledOnce();
});

// ---------------------------------------------------------------------------
// initConnection()
// ---------------------------------------------------------------------------

test("initConnection with url in localStorage and health ok → sets isConnected true", async () => {
  localStorage.setItem(LS_KEY, "http://localhost:3001");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

  await initConnection();

  expect(connection.isConnected).toBe(true);
  expect(connection.apiUrl).toBe("http://localhost:3001");
  expect(setAuthApiUrl).toHaveBeenCalledWith("http://localhost:3001");
});

test("initConnection with url in localStorage but health fails → stays disconnected, url kept in localStorage", async () => {
  localStorage.setItem(LS_KEY, "http://localhost:3001");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

  await initConnection();

  expect(connection.isConnected).toBe(false);
  // URL must be retained in localStorage so the connect screen can prefill it
  expect(localStorage.getItem(LS_KEY)).toBe("http://localhost:3001");
  expect(setAuthApiUrl).not.toHaveBeenCalled();
  // ...and the hub we failed to reach must still be NAMED. The top bar's hub
  // pill exists so a console pointed at nothing cannot look like a working
  // one; a null apiUrl made it say "No hub", which is the same lie.
  expect(connection.apiUrl).toBe("http://localhost:3001");
  expect(connection.error).toBeTruthy();
});

test("initConnection when the probe throws → still names the hub it could not reach", async () => {
  localStorage.setItem(LS_KEY, "https://hub.agentpod.dev");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND")));

  await initConnection();

  expect(connection.isConnected).toBe(false);
  expect(connection.apiUrl).toBe("https://hub.agentpod.dev");
  expect(connection.error).toContain("ENOTFOUND");
  expect(setAuthApiUrl).not.toHaveBeenCalled();
});

test("initConnection with no url in localStorage and no PUBLIC_HUB_URL → stays disconnected, no fetch called", async () => {
  vi.stubEnv("PUBLIC_HUB_URL", "");
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await initConnection();

  expect(connection.isConnected).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

// Regression: a hosted deploy (empty localStorage on first visit) must fall back
// to the build-time PUBLIC_HUB_URL so the auth client gets configured and the
// login guard can run — otherwise an anonymous visitor sees the shell + 401s.
test("initConnection with no localStorage url but PUBLIC_HUB_URL set → connects via it + configures auth client", async () => {
  vi.stubEnv("PUBLIC_HUB_URL", "https://hub.agentpod.dev");
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);

  await initConnection();

  expect(fetchMock).toHaveBeenCalledWith("https://hub.agentpod.dev/health");
  expect(connection.isConnected).toBe(true);
  expect(connection.apiUrl).toBe("https://hub.agentpod.dev");
  expect(setAuthApiUrl).toHaveBeenCalledWith("https://hub.agentpod.dev");
});
