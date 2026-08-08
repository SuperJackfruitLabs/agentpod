/**
 * unauthorized.test.ts
 *
 * TDD: 401 responses from http() (client.ts) must clear the auth session and
 * redirect to /login — unless the current path is already a public route
 * (/login), in which case no redirect should fire (loop guard).
 *
 * Run: cd apps/console && pnpm test src/lib/api/unauthorized.test.ts
 */

import { vi, test, expect, beforeEach, afterEach } from "vitest";

// ─── Hoist mock functions so factory closures can reference them ──────────────

const { mockGoto, mockClearAuthSession } = vi.hoisted(() => ({
  mockGoto: vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined),
  mockClearAuthSession: vi.fn<() => void>(),
}));

// ─── Module mocks (hoisted before imports by Vitest) ─────────────────────────

vi.mock("$app/navigation", () => ({
  goto: mockGoto,
  invalidate: vi.fn(),
  invalidateAll: vi.fn(),
  preloadData: vi.fn(),
  preloadCode: vi.fn(),
  beforeNavigate: vi.fn(),
  afterNavigate: vi.fn(),
  pushState: vi.fn(),
  replaceState: vi.fn(),
}));

vi.mock("$lib/stores/auth.svelte", () => ({
  clearAuthSession: mockClearAuthSession,
}));

// ─── Module under test (imported after mocks are registered) ─────────────────

import { listNodes } from "./client";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stub globalThis.fetch to return a minimal Response-like with the given status. */
function stubFetch(status: number) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_h: string) => null },
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response);
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  mockGoto.mockReset();
  mockClearAuthSession.mockReset();
  // Provide a deterministic hub URL so hubUrl() resolves immediately
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
  // Default: user is on a protected route
  vi.stubGlobal("location", { pathname: "/" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("401 on protected route (/) → clearAuthSession called, goto('/login') called, request rejects", async () => {
  stubFetch(401);

  await expect(listNodes()).rejects.toThrow("Your session has expired — sign in again.");
  expect(mockClearAuthSession).toHaveBeenCalledOnce();
  expect(mockGoto).toHaveBeenCalledOnce();
  expect(mockGoto).toHaveBeenCalledWith("/login");
});

test("401 on /nodes/x → same redirect behaviour (protected sub-path)", async () => {
  vi.stubGlobal("location", { pathname: "/nodes/abc-123" });
  stubFetch(401);

  await expect(listNodes()).rejects.toThrow("Your session has expired — sign in again.");
  expect(mockClearAuthSession).toHaveBeenCalledOnce();
  expect(mockGoto).toHaveBeenCalledWith("/login");
});

test("401 while already on /login → goto NOT called (loop guard)", async () => {
  vi.stubGlobal("location", { pathname: "/login" });
  stubFetch(401);

  await expect(listNodes()).rejects.toThrow("Your session has expired — sign in again.");
  expect(mockGoto).not.toHaveBeenCalled();
  expect(mockClearAuthSession).not.toHaveBeenCalled();
});

test("non-401 error (403) → goto NOT called, request still rejects", async () => {
  stubFetch(403);

  await expect(listNodes()).rejects.toThrow("You don't have permission to do that.");
  expect(mockGoto).not.toHaveBeenCalled();
  expect(mockClearAuthSession).not.toHaveBeenCalled();
});
