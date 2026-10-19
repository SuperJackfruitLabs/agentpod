import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";

const { pageState } = vi.hoisted(() => ({
  pageState: { status: 500, error: { message: "boom" } as { message: string } | null },
}));
vi.mock("$app/state", () => ({ page: pageState }));

import ErrorPage from "./+error.svelte";

const reload = vi.fn();
beforeEach(() => {
  reload.mockReset();
  vi.stubGlobal("location", { ...window.location, reload });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("an error offers Reload, which reloads the page", async () => {
  pageState.status = 500;
  pageState.error = { message: "boom" };
  const { getByRole, getByText } = render(ErrorPage);
  expect(getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
  expect(getByText("boom")).toBeTruthy();
  await fireEvent.click(getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalled();
  expect(getByRole("link", { name: "Back to Overview" }).getAttribute("href")).toBe("/");
});

test("a 404 says the page was not found and offers no Reload", () => {
  pageState.status = 404;
  pageState.error = null;
  const { getByRole, queryByRole } = render(ErrorPage);
  expect(getByRole("heading", { name: "Page not found" })).toBeTruthy();
  expect(queryByRole("button", { name: "Reload" })).toBeNull();
});
