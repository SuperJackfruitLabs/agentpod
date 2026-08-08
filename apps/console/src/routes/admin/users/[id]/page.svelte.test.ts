/**
 * page.svelte.test.ts
 *
 * TDD tests for the minimal fleet admin user-detail page.
 * RED → implement +page.svelte → GREEN.
 *
 * Asserts:
 *  - Shows the user email (u@x)
 *  - Renders a Ban control
 *  - Renders a role control
 */

import { test, expect, vi } from "vitest";
import { render } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

// Stub svelte-sonner (its runed dependency can't resolve in vite@5 test env)
vi.mock("svelte-sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("$app/state", () => ({
  page: {
    params: { id: "u1" },
    url: { pathname: "/admin/users/u1" },
    data: {},
    form: null,
    status: 200,
    error: null,
    route: { id: "/admin/users/[id]" },
  },
}));

// ---------------------------------------------------------------------------
// Admin API mock — use the REAL exported function names from $lib/api/admin
// ---------------------------------------------------------------------------

vi.mock("$lib/api/admin", () => ({
  getUser: vi.fn().mockResolvedValue({
    user: {
      id: "u1",
      email: "u@x",
      name: "U",
      role: "user",
      banned: false,
      bannedReason: null,
      bannedAt: null,
      emailVerified: true,
      image: null,
      createdAt: "2026-06-29T00:00:00Z",
      updatedAt: "2026-06-29T00:00:00Z",
      sandboxCount: 0,
      runningSandboxCount: 0,
    },
  }),
  banUser: vi.fn().mockResolvedValue({ id: "u1" }),
  unbanUser: vi.fn().mockResolvedValue({ id: "u1" }),
  updateUserRole: vi.fn().mockResolvedValue({ id: "u1" }),
}));

// ---------------------------------------------------------------------------
// Static import — compiled once after all mocks are registered
// ---------------------------------------------------------------------------

import UserDetailPage from "./+page.svelte";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("shows the user email", async () => {
  const { container } = render(UserDetailPage);
  // Allow async onMount to resolve
  await new Promise((r) => setTimeout(r, 0));
  expect(container.textContent).toContain("u@x");
});

test("renders a Ban control", async () => {
  const { container } = render(UserDetailPage);
  await new Promise((r) => setTimeout(r, 0));
  const text = container.textContent ?? "";
  const hasBan =
    text.toLowerCase().includes("ban") ||
    !!container.querySelector('[data-testid="ban-user"]');
  expect(hasBan).toBe(true);
});

test("renders a role control", async () => {
  const { container } = render(UserDetailPage);
  await new Promise((r) => setTimeout(r, 0));
  const text = container.textContent ?? "";
  const hasRole =
    text.toLowerCase().includes("role") ||
    text.toLowerCase().includes("admin") ||
    !!container.querySelector('[data-testid="change-role"]');
  expect(hasRole).toBe(true);
});

test("banned user renders the Banned status label", async () => {
  const { getUser } = await import("$lib/api/admin");
  vi.mocked(getUser).mockResolvedValueOnce({
    user: {
      id: "u1",
      email: "u@x",
      name: "U",
      role: "user",
      banned: true,
      bannedReason: "Spam",
      bannedAt: "2026-07-01T00:00:00Z",
      emailVerified: true,
      image: null,
      createdAt: "2026-06-29T00:00:00Z",
      updatedAt: "2026-06-29T00:00:00Z",
      sandboxCount: 0,
      runningSandboxCount: 0,
    },
    usage: {
      sandboxCount: 0,
      runningSandboxCount: 0,
      totalCpuCores: 0,
      totalMemoryGb: 0,
    },
  });

  const { container } = render(UserDetailPage);
  await new Promise((r) => setTimeout(r, 0));
  expect(container.textContent).toContain("Banned");
});
