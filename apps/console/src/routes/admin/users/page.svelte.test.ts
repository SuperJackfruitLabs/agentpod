/**
 * page.svelte.test.ts
 *
 * TDD tests for the admin users list orchestrator (rebuilt on DataTable in
 * manualPagination mode, composed from the shared admin/* components).
 * RED → rebuild +page.svelte → GREEN.
 *
 * Asserts:
 *  - renders users from listUsers
 *  - ban flow: Ban button opens BanUserDialog, confirming with a reason calls banUser
 *  - role badge opens RoleDialog
 *  - signup toggle calls enable/disableSignup
 *  - pagination Next calls listUsers with offset = pageSize
 *  - create-user flow validates password length before calling createUser
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, screen } from "@testing-library/svelte";

// ---------------------------------------------------------------------------
// SvelteKit stubs
// ---------------------------------------------------------------------------

vi.mock("$app/navigation", () => ({
  goto: vi.fn(),
}));

vi.mock("$app/state", () => ({
  page: {
    params: {},
    url: { pathname: "/admin/users" },
    data: {},
    form: null,
    status: 200,
    error: null,
    route: { id: "/admin/users" },
  },
}));

// Stub svelte-sonner (its runed dependency can't resolve in vite@5 test env)
vi.mock("svelte-sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Admin API mock — use the REAL exported function names from $lib/api/admin
// (covers the page itself plus every shared dialog it renders)
// ---------------------------------------------------------------------------

// vi.mock factories are hoisted above the rest of the module, so any value
// they close over must be declared through vi.hoisted() (a plain top-level
// const would throw a temporal-dead-zone ReferenceError at import time).
const { makeUser, mockStats } = vi.hoisted(() => {
  type MockUser = {
    id: string;
    email: string;
    name: string;
    image: string | null;
    emailVerified: boolean;
    role: "user" | "admin";
    banned: boolean;
    bannedReason: string | null;
    bannedAt: string | null;
    createdAt: string;
    updatedAt: string;
    sandboxCount: number;
    runningSandboxCount: number;
  };

  function makeUser(overrides: Partial<MockUser> = {}): MockUser {
    return {
      id: "u1",
      email: "u1@x.test",
      name: "User One",
      image: null,
      emailVerified: true,
      role: "user",
      banned: false,
      bannedReason: null,
      bannedAt: null,
      createdAt: "2026-06-29T00:00:00Z",
      updatedAt: "2026-06-29T00:00:00Z",
      sandboxCount: 0,
      runningSandboxCount: 0,
      ...overrides,
    };
  }

  const mockStats = {
    totalUsers: 2,
    adminUsers: 1,
    bannedUsers: 0,
    totalSandboxes: 0,
    runningSandboxes: 0,
    usersThisWeek: 1,
  };

  return { makeUser, mockStats };
});

vi.mock("$lib/api/admin", () => ({
  listUsers: vi.fn().mockResolvedValue({
    users: [makeUser(), makeUser({ id: "u2", email: "u2@x.test", name: "User Two", role: "admin" })],
    total: 2,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 1,
  }),
  getAdminStats: vi.fn().mockResolvedValue(mockStats),
  getSignupStatus: vi.fn().mockResolvedValue({ enabled: true }),
  enableSignup: vi.fn().mockResolvedValue({ enabled: true }),
  disableSignup: vi.fn().mockResolvedValue({ enabled: false }),
  banUser: vi.fn().mockResolvedValue(makeUser({ banned: true })),
  unbanUser: vi.fn().mockResolvedValue(makeUser({ banned: false })),
  updateUserRole: vi.fn().mockResolvedValue(makeUser({ role: "admin" })),
  createUser: vi.fn().mockResolvedValue(makeUser({ id: "u3" })),
}));

// ---------------------------------------------------------------------------
// Static import — compiled once after all mocks are registered
// ---------------------------------------------------------------------------

import UsersPage from "./+page.svelte";
import * as adminApi from "$lib/api/admin";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders users from listUsers", async () => {
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    users: [makeUser(), makeUser({ id: "u2", email: "u2@x.test", name: "User Two", role: "admin" })],
    total: 2,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 1,
  });
  vi.mocked(adminApi.getAdminStats).mockResolvedValue(mockStats);
  vi.mocked(adminApi.getSignupStatus).mockResolvedValue({ enabled: true });

  const { getByText, getAllByTestId } = render(UsersPage);

  await waitFor(() => {
    expect(getByText("u1@x.test")).toBeTruthy();
    expect(getByText("u2@x.test")).toBeTruthy();
  });
  expect(getAllByTestId("user-row").length).toBe(2);
});

test("ban flow: Ban button opens the dialog and confirming a reason calls banUser", async () => {
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    users: [makeUser()],
    total: 1,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 1,
  });

  const { getAllByTestId, getByLabelText, getByRole } = render(UsersPage);

  await waitFor(() => {
    expect(getAllByTestId("ban-btn").length).toBe(1);
  });

  await fireEvent.click(getAllByTestId("ban-btn")[0]);

  const textarea = await waitFor(() => getByLabelText(/reason/i));
  await fireEvent.input(textarea, { target: { value: "spamming" } });

  const confirmBtn = getByRole("button", { name: /ban user/i }) as HTMLButtonElement;
  await waitFor(() => expect(confirmBtn.disabled).toBe(false));
  await fireEvent.click(confirmBtn);

  await waitFor(() => {
    expect(adminApi.banUser).toHaveBeenCalledWith("u1", "spamming");
  });
});

test("role badge opens the role dialog", async () => {
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    users: [makeUser()],
    total: 1,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 1,
  });

  const { getAllByTestId, getByText } = render(UsersPage);

  await waitFor(() => {
    expect(getAllByTestId("role-badge").length).toBe(1);
  });

  await fireEvent.click(getAllByTestId("role-badge")[0]);

  await waitFor(() => {
    expect(getByText("Change role")).toBeTruthy();
  });
});

test("signup toggle calls enable/disableSignup", async () => {
  vi.mocked(adminApi.getSignupStatus).mockResolvedValue({ enabled: true });

  const { getByRole } = render(UsersPage);

  const toggle = await waitFor(() => getByRole("switch"));
  await fireEvent.click(toggle);

  await waitFor(() => {
    expect(adminApi.disableSignup).toHaveBeenCalledOnce();
  });
});

test("pagination Next calls listUsers with offset = pageSize", async () => {
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    users: [makeUser(), makeUser({ id: "u2", email: "u2@x.test", name: "User Two" })],
    total: 45,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 3,
  });

  const { getByRole, getAllByTestId } = render(UsersPage);

  await waitFor(() => {
    expect(getAllByTestId("user-row").length).toBe(2);
  });

  const nextBtn = getByRole("button", { name: /^next$/i });
  await fireEvent.click(nextBtn);

  await waitFor(() => {
    expect(adminApi.listUsers).toHaveBeenCalledTimes(2);
  });
  const secondCallOptions = vi.mocked(adminApi.listUsers).mock.calls[1][0];
  expect(secondCallOptions).toMatchObject({ offset: 20 });
});

test("create-user flow validates password length before calling createUser", async () => {
  vi.mocked(adminApi.listUsers).mockResolvedValue({
    users: [makeUser()],
    total: 1,
    limit: 20,
    offset: 0,
    page: 1,
    totalPages: 1,
  });

  const { getByTestId, getByLabelText, getByText } = render(UsersPage);

  await waitFor(() => {
    expect(getByTestId("create-user-btn")).toBeTruthy();
  });

  await fireEvent.click(getByTestId("create-user-btn"));

  const nameInput = await waitFor(() => getByLabelText(/name/i));
  await fireEvent.input(nameInput, { target: { value: "Jane Doe" } });
  await fireEvent.input(getByLabelText(/email/i), { target: { value: "jane@x.test" } });
  await fireEvent.input(getByLabelText(/password/i), { target: { value: "short" } });

  // Two "Create user" buttons exist (header CTA + dialog submit) — the
  // dialog's confirm button is the one rendered last (bits-ui portals the
  // dialog content to the end of <body>), matching the runtimes test's
  // established pattern for disambiguating a dialog's own action button.
  const createButtons = screen.getAllByRole("button", { name: /^create user$/i });
  await fireEvent.click(createButtons[createButtons.length - 1]);

  await waitFor(() => {
    expect(getByText(/at least 8 characters/i)).toBeTruthy();
  });
  expect(adminApi.createUser).not.toHaveBeenCalled();
});
