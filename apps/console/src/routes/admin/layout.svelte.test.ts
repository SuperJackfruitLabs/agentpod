/**
 * The admin guard: a real 403 is "Access denied"; anything else that stops the check (the hub
 * unreachable, a 500) is a retryable error, never a permission verdict (defect fix: the guard used
 * to read every failure as "You do not have permission").
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$lib/stores/connection.svelte", () => ({ connection: { isConnected: true } }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: { isAuthenticated: true } }));
vi.mock("$lib/api/admin", () => ({ getAdminStats: vi.fn() }));

import * as adminApi from "$lib/api/admin";
import { ApiError } from "$lib/api/http-error";
import AdminLayout from "./+layout.svelte";

const children = createRawSnippet(() => ({ render: () => "<p>Admin content</p>" }));

beforeEach(() => vi.mocked(adminApi.getAdminStats).mockReset());
afterEach(() => cleanup());

test("an admin sees the admin content", async () => {
  vi.mocked(adminApi.getAdminStats).mockResolvedValue({} as never);
  const { findByText } = render(AdminLayout, { props: { children } });
  expect(await findByText("Admin content")).toBeTruthy();
});

test("a real 403 is Access denied, with no Retry", async () => {
  vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(
    new ApiError("You don't have permission to do that.", { status: 403, detail: "GET /api/admin/stats → 403" }),
  );
  const { findByText, queryByRole, getByRole } = render(AdminLayout, { props: { children } });
  expect(await findByText("You do not have permission to access this area.")).toBeTruthy();
  expect(getByRole("button", { name: "Return to home" })).toBeTruthy();
  expect(queryByRole("button", { name: "Retry" })).toBeNull();
});

test.each([
  ["the hub unreachable", new ApiError("Couldn't reach the hub — check your connection.", { status: null, detail: "GET /api/admin/stats" })],
  ["a 500", new ApiError("The hub hit an internal error. Try again in a moment.", { status: 500, detail: "GET /api/admin/stats → 500" })],
])("%s is a retryable error, not a permission verdict", async (_name, err) => {
  vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(err).mockResolvedValueOnce({} as never);
  const { findByRole, queryByText, findByText } = render(AdminLayout, { props: { children } });
  const alert = await findByRole("alert");
  expect(alert.textContent).toContain(err.message);
  expect(queryByText("You do not have permission to access this area.")).toBeNull();
  await fireEvent.click(await findByRole("button", { name: "Retry" }));
  expect(await findByText("Admin content")).toBeTruthy();
  await waitFor(() => expect(adminApi.getAdminStats).toHaveBeenCalledTimes(2));
});
