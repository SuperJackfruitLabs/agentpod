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
 *    record of. Those still match if that id is ever reissued, and they are
 *    exactly what nobody goes looking for.
 *
 * Everything below is keyed by PRINCIPAL. A grant's row is
 * `principal_grants.principal_id`, a foreign key onto `principals.id`, and the
 * values are principal ids too — a page keyed on Better Auth users PUT to an id
 * that cannot exist in that column, so every save failed and every real grant
 * rendered as an orphan.
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

vi.mock("$lib/api/grants", async () => {
  const actual = await vi.importActual<typeof import("$lib/api/grants")>("$lib/api/grants");
  return {
    grantValueProblem: actual.grantValueProblem,
    listGrants: vi.fn(),
    listPrincipals: vi.fn(),
    setGrant: vi.fn(),
    deleteGrant: vi.fn(),
  };
});

import * as adminApi from "$lib/api/admin";
import * as grantsApi from "$lib/api/grants";
import type { PrincipalSummary } from "$lib/api/grants";
import GrantsPage from "./+page.svelte";

const JO = "prn_00000000000000000001";
const QUILL = "prn_00000000000000000002";

function user(id: string, email: string, name = "Jo") {
  return {
    id,
    email,
    name,
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

const JO_PRINCIPAL: PrincipalSummary = {
  id: JO,
  kind: "human",
  handle: "jo",
  displayName: null,
  userId: "user_1",
};

function setup({
  users = [user("user_1", "jo@example.com")],
  principals = [JO_PRINCIPAL] as PrincipalSummary[],
  grants = [] as Array<{ principalId: string; mayDispatch: string[]; mayGrantReach: boolean }>,
  enforced = true,
  directoryFails = false,
} = {}) {
  vi.mocked(adminApi.listUsers).mockResolvedValue({ users, total: users.length } as never);
  if (directoryFails) {
    vi.mocked(grantsApi.listPrincipals).mockRejectedValue(new Error("directory unreachable"));
  } else {
    vi.mocked(grantsApi.listPrincipals).mockResolvedValue(principals as never);
  }
  vi.mocked(grantsApi.listGrants).mockResolvedValue({ grants, enforced });
  return render(GrantsPage);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("lists a principal's grant values", async () => {
  const { findByText } = setup({
    grants: [{ principalId: JO, mayDispatch: [QUILL], mayGrantReach: false }],
  });

  expect(await findByText("Jo")).toBeTruthy();
  expect(await findByText(QUILL)).toBeTruthy();
});

test("keys a row on the principal, not on the Better Auth user behind it", async () => {
  // The bug this replaces: a grant keyed by `user.id` is not a grant on the
  // wrong principal, it is an INSERT that violates a foreign key — so every
  // save failed and every real grant showed up as an orphan.
  const { findByRole } = setup({
    grants: [{ principalId: JO, mayDispatch: [], mayGrantReach: false }],
  });

  await fireEvent.click(await findByRole("button", { name: /remove grant for/i }));
  await fireEvent.click(await findByRole("button", { name: /^remove grant$/i }));

  await waitFor(() => expect(grantsApi.deleteGrant).toHaveBeenCalledWith(JO));
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

  expect(await findByText("Jo")).toBeTruthy();
  // Exact: the enforced banner also explains what having no grant costs.
  expect(await findByText("No grant.")).toBeTruthy();
});

test("shows an agent, because an agent is a principal and can hold a grant too", async () => {
  // The directory is not a user list. An agent has no Better Auth login and
  // would never have appeared on this page before.
  const { findByText } = setup({
    principals: [
      JO_PRINCIPAL,
      { id: QUILL, kind: "agent", handle: "quill", displayName: "Quill", userId: null },
    ] satisfies PrincipalSummary[],
  });

  expect(await findByText("Quill")).toBeTruthy();
});

test("keeps a grant whose principal this hub has no record of, and marks it", async () => {
  const { findByText } = setup({
    grants: [
      { principalId: "prn_0000000000000000dead", mayDispatch: [QUILL], mayGrantReach: false },
    ],
  });

  expect(await findByText("prn_0000000000000000dead")).toBeTruthy();
  expect(await findByText(/no such principal/i)).toBeTruthy();
});

test("distinguishes granted-nothing from never-granted", async () => {
  // Both deny. They read differently to whoever comes next, and the difference
  // is the only record of whether anyone considered this principal at all.
  const { findByText } = setup({
    grants: [{ principalId: JO, mayDispatch: [], mayGrantReach: false }],
  });

  expect(await findByText(/considered, and permitted nothing/i)).toBeTruthy();
});

test("removing a grant asks first, then reloads", async () => {
  const { findByRole, getByRole } = setup({
    grants: [{ principalId: JO, mayDispatch: [QUILL], mayGrantReach: false }],
  });

  await fireEvent.click(await findByRole("button", { name: /remove grant for/i }));
  await fireEvent.click(getByRole("button", { name: /^remove grant$/i }));

  await waitFor(() => expect(grantsApi.deleteGrant).toHaveBeenCalledWith(JO));
  // Reloaded rather than patched locally: the server is the authority on what a
  // grant is now, and a stale row here is a wrong belief about permission.
  await waitFor(() => expect(grantsApi.listGrants).toHaveBeenCalledTimes(2));
});

test("an unreachable directory does not stop grant editing", async () => {
  // Narrowing a grant is exactly what you do when something has gone wrong, so
  // the directory that supplies readable names must not take the page with it.
  // Every grant still has to be shown; it just shows the bare id.
  const { findByText } = setup({
    directoryFails: true,
    grants: [{ principalId: JO, mayDispatch: [QUILL], mayGrantReach: false }],
  });

  expect(await findByText(QUILL)).toBeTruthy();
});
