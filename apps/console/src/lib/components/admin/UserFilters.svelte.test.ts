/**
 * UserFilters.svelte.test.ts
 *
 * TDD tests for the shared admin users search/filter bar, extracted from
 * the admin users list page's inline filter bar.
 *
 * Regression coverage: the pre-rebuild page refetched immediately when the
 * Role/Status Select changed (`onValueChange` → reset page + loadData).
 * The extracted component must preserve that auto-apply behavior via an
 * optional `onFilterChange` callback, fired after the bindable value is
 * updated — the text search still waits for onSearch/Enter.
 */

import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";

// bits-ui's Select opens on `pointerdown` (not `click`) and picks an item on
// `pointerup`, and touches `hasPointerCapture`/`releasePointerCapture` along
// the way — jsdom implements neither a `PointerEvent` constructor nor those
// capture methods. Polyfill just enough for these interaction tests (same
// polyfill as RoleDialog.svelte.test.ts, scoped to this file).
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

import UserFilters from "./UserFilters.svelte";

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function baseProps() {
  return {
    searchQuery: "",
    roleFilter: "all" as const,
    bannedFilter: "all" as const,
    onSearch: vi.fn(),
    onRefresh: vi.fn(),
    isLoading: false,
  };
}

test("changing the role filter fires onFilterChange (auto-apply, no Search click needed)", async () => {
  const onFilterChange = vi.fn();
  const { getByRole } = render(UserFilters, {
    props: { ...baseProps(), onFilterChange },
  });

  const trigger = getByRole("button", { name: /^all roles$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const adminOption = await waitFor(() => getByRole("option", { name: /^admin$/i }));
  await fireEvent.pointerUp(adminOption, { pointerId: 1, button: 0, pointerType: "mouse" });

  await waitFor(() => {
    expect(onFilterChange).toHaveBeenCalledOnce();
  });
});

test("changing the status filter fires onFilterChange (auto-apply, no Search click needed)", async () => {
  const onFilterChange = vi.fn();
  const { getByRole } = render(UserFilters, {
    props: { ...baseProps(), onFilterChange },
  });

  const trigger = getByRole("button", { name: /^all status$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const bannedOption = await waitFor(() => getByRole("option", { name: /^banned$/i }));
  await fireEvent.pointerUp(bannedOption, { pointerId: 1, button: 0, pointerType: "mouse" });

  await waitFor(() => {
    expect(onFilterChange).toHaveBeenCalledOnce();
  });
});

test("onFilterChange is optional — a select change without it doesn't throw", async () => {
  const { getByRole } = render(UserFilters, { props: baseProps() });

  const trigger = getByRole("button", { name: /^all roles$/i });
  await fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, pointerType: "mouse" });
  const adminOption = await waitFor(() => getByRole("option", { name: /^admin$/i }));
  await expect(
    fireEvent.pointerUp(adminOption, { pointerId: 1, button: 0, pointerType: "mouse" })
  ).resolves.not.toThrow();
});

test("typing in search and clicking Search calls onSearch, not onFilterChange", async () => {
  const onSearch = vi.fn();
  const onFilterChange = vi.fn();
  const { getByPlaceholderText, getByRole } = render(UserFilters, {
    props: { ...baseProps(), onSearch, onFilterChange },
  });

  await fireEvent.input(getByPlaceholderText(/search by email or name/i), {
    target: { value: "jane" },
  });
  await fireEvent.click(getByRole("button", { name: /^search$/i }));

  expect(onSearch).toHaveBeenCalledOnce();
  expect(onFilterChange).not.toHaveBeenCalled();
});
