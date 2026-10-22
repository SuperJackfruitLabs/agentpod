/**
 * The admin guard. Two audiences: the workspace pages are for workspace admins, the settings pages
 * for the hub operator. Anyone else is told what the area is and who to ask — never "Access
 * denied". Anything else that stops the check (the hub unreachable, a 500) is a retryable error,
 * never a permission verdict (defect fix: the guard used to read every failure as "You do not have
 * permission").
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";

const mockAuth = vi.hoisted(() => ({ isAuthenticated: true, isWorkspaceAdmin: true, isHubOperator: false }));
const mockPage = vi.hoisted(() => ({ url: new URL("http://localhost/admin/users") }));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({ page: mockPage }));
vi.mock("$lib/stores/connection.svelte", () => ({ connection: { isConnected: true } }));
vi.mock("$lib/stores/auth.svelte", () => ({ auth: mockAuth }));
vi.mock("$lib/api/admin", () => ({ getAdminStats: vi.fn() }));

import * as adminApi from "$lib/api/admin";
import { ApiError } from "$lib/api/http-error";
import AdminLayout from "./+layout.svelte";

const children = createRawSnippet(() => ({ render: () => "<p>Admin content</p>" }));

beforeEach(() => {
  vi.mocked(adminApi.getAdminStats).mockReset();
  mockAuth.isWorkspaceAdmin = true;
  mockAuth.isHubOperator = false;
  mockPage.url = new URL("http://localhost/admin/users");
});
afterEach(() => cleanup());

test("a workspace admin sees the admin content", async () => {
  vi.mocked(adminApi.getAdminStats).mockResolvedValue({} as never);
  const { findByText } = render(AdminLayout, { props: { children } });
  expect(await findByText("Admin content")).toBeTruthy();
});

test("a member opening a workspace admin page is told what it is and who to ask, without asking the hub", async () => {
  mockAuth.isWorkspaceAdmin = false;
  const { findByRole, getByTestId, queryByText } = render(AdminLayout, { props: { children } });
  const h = await findByRole("heading", { level: 1, name: "Workspace admin" });
  expect(document.activeElement).toBe(h);
  const text = getByTestId("admin-not-for-you").textContent?.replace(/\s+/g, " ");
  expect(text).toContain("for the workspace's owners and admins");
  expect(text).toContain("Ask an owner or admin of your workspace.");
  expect(queryByText(/Access denied|You do not have permission/)).toBeNull();
  expect(queryByText("Admin content")).toBeNull();
  expect(adminApi.getAdminStats).not.toHaveBeenCalled();
});

test("a workspace admin who is not the hub operator gets the plain page on a hub setting", async () => {
  mockPage.url = new URL("http://localhost/admin/speech");
  const { findByRole, getByTestId } = render(AdminLayout, { props: { children } });
  expect(await findByRole("heading", { level: 1, name: "Hub settings" })).toBeTruthy();
  expect(getByTestId("admin-not-for-you").textContent?.replace(/\s+/g, " ")).toContain("changed by the hub's operator");
});

test("a hub operator opens the hub settings without the workspace probe", async () => {
  mockAuth.isWorkspaceAdmin = false;
  mockAuth.isHubOperator = true;
  mockPage.url = new URL("http://localhost/admin/transcription");
  const { findByText } = render(AdminLayout, { props: { children } });
  expect(await findByText("Admin content")).toBeTruthy();
  expect(adminApi.getAdminStats).not.toHaveBeenCalled();
});

test("a real 403 from the probe is the same plain page, with no Retry", async () => {
  vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(
    new ApiError("Only workspace admins can do that. Ask an owner or admin of your workspace.", { status: 403, detail: "GET /api/admin/stats → 403", code: "workspace_admin_required" }),
  );
  const { findByTestId, queryByRole } = render(AdminLayout, { props: { children } });
  expect((await findByTestId("admin-not-for-you")).textContent).toContain("Ask an owner or admin of your workspace.");
  expect(queryByRole("button", { name: "Retry" })).toBeNull();
});

test.each([
  ["the hub unreachable", new ApiError("Couldn't reach the hub — check your connection.", { status: null, detail: "GET /api/admin/stats" })],
  ["a 500", new ApiError("The hub hit an internal error. Try again in a moment.", { status: 500, detail: "GET /api/admin/stats → 500" })],
])("%s is a retryable error, not a permission verdict", async (_name, err) => {
  vi.mocked(adminApi.getAdminStats).mockRejectedValueOnce(err).mockResolvedValueOnce({} as never);
  const { findByRole, queryByTestId, findByText } = render(AdminLayout, { props: { children } });
  const alert = await findByRole("alert");
  expect(alert.textContent).toContain(err.message);
  expect(queryByTestId("admin-not-for-you")).toBeNull();
  await fireEvent.click(await findByRole("button", { name: "Retry" }));
  expect(await findByText("Admin content")).toBeTruthy();
  await waitFor(() => expect(adminApi.getAdminStats).toHaveBeenCalledTimes(2));
});
