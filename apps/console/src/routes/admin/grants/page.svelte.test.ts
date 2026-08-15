/**
 * page.svelte.test.ts
 *
 * The grants page — the first place an operator can see who may dispatch what.
 *
 * Two beliefs this page must never create, and both are asserted here:
 *
 *  - that a grant is being enforced when nothing is enforcing it. With
 *    `ENFORCE_CONTROL_PAIR` unset every row here is decoration, and a narrow
 *    grant would read as a locked-down fleet.
 *  - that the list is complete when a grant names a principal this hub has no
 *    user for. Those still match if that id is ever reissued, and they are
 *    exactly what nobody goes looking for.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/admin", () => ({
  listUsers: vi.fn(),
}));

vi.mock("$lib/api/client", () => ({
  listNodes: vi.fn(),
  listStations: vi.fn(),
}));

vi.mock("$lib/api/grants", async () => {
  const actual = await vi.importActual<typeof import("$lib/api/grants")>("$lib/api/grants");
  return {
    grantValueProblem: actual.grantValueProblem,
    KNOWN_PLANES: actual.KNOWN_PLANES,
    listGrants: vi.fn(),
    setGrant: vi.fn(),
    deleteGrant: vi.fn(),
  };
});

import * as adminApi from "$lib/api/admin";
import * as clientApi from "$lib/api/client";
import * as grantsApi from "$lib/api/grants";
import GrantsPage from "./+page.svelte";

function user(id: string, email: string) {
  return {
    id,
    email,
    name: "",
    image: null,
    emailVerified: true,
    role: "user",
    banned: false,
    bannedReason: null,
    bannedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function setup({
  users = [user("user_1", "jo@example.com")],
  grants = [] as Array<{ principalId: string; mayDispatch: string[]; mayGrantReach: boolean }>,
  enforced = true,
} = {}) {
  vi.mocked(adminApi.listUsers).mockResolvedValue({ users, total: users.length } as never);
  vi.mocked(grantsApi.listGrants).mockResolvedValue({ grants, enforced });
  vi.mocked(clientApi.listNodes).mockResolvedValue([] as never);
  return render(GrantsPage);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("lists a principal's grant values", async () => {
  const { findByText } = setup({
    grants: [
      { principalId: "user_1", mayDispatch: ["agentpod:molt-bot/hermes:*"], mayGrantReach: false },
    ],
  });

  expect(await findByText("jo@example.com")).toBeTruthy();
  expect(await findByText("agentpod:molt-bot/hermes:*")).toBeTruthy();
});

test("says so loudly when nothing is enforcing these grants", async () => {
  const { findByTestId } = setup({ enforced: false });

  const banner = await findByTestId("enforcement-banner");
  // Collapsed: the copy wraps, so the rendered text carries newlines mid-phrase.
  const text = banner.textContent!.replace(/\s+/g, " ");
  expect(text).toMatch(/not enforced/i);
  // The consequence, not just the state: a page that said "disabled" and stopped
  // would still let someone read a narrow grant as a narrow fleet.
  expect(text).toMatch(/every principal can dispatch every agent/i);
});

test("shows a principal with no grant rather than hiding them", async () => {
  // "No grant" is the state that denies everything under enforcement — the last
  // thing to discover by having dispatch fail.
  const { findByText } = setup({ grants: [] });

  expect(await findByText("jo@example.com")).toBeTruthy();
  // Exact: the enforced banner also explains what having no grant costs.
  expect(await findByText("No grant.")).toBeTruthy();
});

test("keeps a grant whose principal is not a user here, and marks it", async () => {
  const { findByText } = setup({
    grants: [
      { principalId: "user_gone", mayDispatch: ["kaambaan:agt_7abf"], mayGrantReach: false },
    ],
  });

  expect(await findByText("user_gone")).toBeTruthy();
  expect(await findByText(/no such user/i)).toBeTruthy();
});

test("distinguishes granted-nothing from never-granted", async () => {
  // Both deny. They read differently to whoever comes next, and the difference
  // is the only record of whether anyone considered this principal at all.
  const { findByText } = setup({
    users: [user("user_1", "jo@example.com")],
    grants: [{ principalId: "user_1", mayDispatch: [], mayGrantReach: false }],
  });

  expect(await findByText(/considered, and permitted nothing/i)).toBeTruthy();
});

test("removing a grant asks first, then reloads", async () => {
  const { findByRole, getByRole } = setup({
    grants: [
      { principalId: "user_1", mayDispatch: ["kaambaan:agt_7abf"], mayGrantReach: false },
    ],
  });

  await fireEvent.click(await findByRole("button", { name: /remove grant for/i }));
  await fireEvent.click(getByRole("button", { name: /^remove grant$/i }));

  await waitFor(() => expect(grantsApi.deleteGrant).toHaveBeenCalledWith("user_1"));
  // Reloaded rather than patched locally: the server is the authority on what a
  // grant is now, and a stale row here is a wrong belief about permission.
  await waitFor(() => expect(grantsApi.listGrants).toHaveBeenCalledTimes(2));
});

test("an unreachable fleet does not stop grant editing", async () => {
  // Narrowing a grant is exactly what you do when something has gone wrong, so
  // station suggestions failing must not take the page with them.
  vi.mocked(clientApi.listNodes).mockRejectedValue(new Error("nodes unreachable"));
  const { findByText } = setup({
    grants: [
      { principalId: "user_1", mayDispatch: ["kaambaan:agt_7abf"], mayGrantReach: false },
    ],
  });

  expect(await findByText("kaambaan:agt_7abf")).toBeTruthy();
});
