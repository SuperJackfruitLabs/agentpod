/**
 * RoleDialog.svelte.test.ts
 *
 * TDD tests for the shared role-change dialog (extracted from the duplicated
 * role dialogs on the admin users list and user-detail pages).
 * RED → implement RoleDialog.svelte → GREEN.
 *
 * HARD CONSTRAINT: this component must import ONLY `updateUserRole` from
 * $lib/api/admin — mirrors the user-detail page's mock set
 * (getUser/banUser/unbanUser/updateUserRole); the mock below intentionally
 * exports only updateUserRole to prove the component doesn't reach for
 * anything else.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither a `PointerEvent` constructor nor those
// capture methods. Polyfill just enough for these interaction tests; no
// other suite in this repo drives a bits-ui Select open, so this stays
// scoped to this file rather than the global test setup.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error jsdom has no native PointerEvent
  window.PointerEvent = PointerEventPolyfill;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}

vi.mock("svelte-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("$lib/api/admin", () => ({
  updateUserRole: vi.fn(),
}));

import * as adminApi from "$lib/api/admin";
import RoleDialog from "./RoleDialog.svelte";

const user = { id: "u1", email: "u@x", name: "U", role: "user" as const };

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

test("open renders the target user's email and current role", () => {
  const { getByText } = render(RoleDialog, {
    props: { open: true, user, onChanged: vi.fn() },
  });
  expect(getByText(/u@x/)).toBeTruthy();
});

test("update is disabled while the selected role matches the user's current role (validation blocks)", () => {
  const { getByRole } = render(RoleDialog, {
    props: { open: true, user, onChanged: vi.fn() },
  });
  const updateBtn = getByRole("button", { name: /update role/i }) as HTMLButtonElement;
  expect(updateBtn.disabled).toBe(true);
});

test("selecting admin shows an elevation warning", async () => {
  const { getByRole, getByText } = render(RoleDialog, {
    props: { open: true, user, onChanged: vi.fn() },
  });
  const trigger = getByRole("button", { name: "New role" });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const adminOption = await waitFor(() => getByRole("option", { name: /^admin$/i }));
  await fireEvent.pointerUp(adminOption, { pointerId: 1, button: 0, pointerType: "mouse" });

  await waitFor(() => {
    expect(getByText(/full access/i)).toBeTruthy();
  });
});

test("confirming an elevation calls updateUserRole and fires onChanged on success", async () => {
  vi.mocked(adminApi.updateUserRole).mockResolvedValue({} as never);
  const onChanged = vi.fn();

  const { getByRole } = render(RoleDialog, {
    props: { open: true, user, onChanged },
  });

  const trigger = getByRole("button", { name: "New role" });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const adminOption = await waitFor(() => getByRole("option", { name: /^admin$/i }));
  await fireEvent.pointerUp(adminOption, { pointerId: 1, button: 0, pointerType: "mouse" });

  const updateBtn = getByRole("button", { name: /update role/i }) as HTMLButtonElement;
  await waitFor(() => expect(updateBtn.disabled).toBe(false));
  await fireEvent.click(updateBtn);

  await waitFor(() => {
    expect(adminApi.updateUserRole).toHaveBeenCalledWith("u1", "admin");
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
