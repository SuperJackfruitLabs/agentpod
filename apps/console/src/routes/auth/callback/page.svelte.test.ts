import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
import { goto } from "$app/navigation";
import * as plane from "$lib/auth/org-plane";
import * as authStore from "$lib/stores/auth.svelte";
import Page from "./+page.svelte";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(goto).mockReset();
});

test("completes the sign-in and goes to where the user was going", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  vi.spyOn(plane, "completeSignIn").mockResolvedValue({ returnTo: "/nodes" });
  const init = vi.spyOn(authStore, "initAuth").mockResolvedValue();
  window.history.replaceState({}, "", "/auth/callback?code=c&state=s");
  render(Page);
  await waitFor(() => expect(goto).toHaveBeenCalledWith("/nodes", { replaceState: true }));
  expect(init).toHaveBeenCalled();
});

test("an error from the plane is shown, not swallowed", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  window.history.replaceState({}, "", "/auth/callback?error=access_denied&error_description=Denied");
  const { findByText } = render(Page);
  expect(await findByText(/Denied/)).toBeTruthy();
  expect(goto).not.toHaveBeenCalled();
});

test("a hub without a plane says so instead of trying to sign in", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue(null);
  const complete = vi.spyOn(plane, "completeSignIn");
  window.history.replaceState({}, "", "/auth/callback?code=c&state=s");
  const { findByText } = render(Page);
  expect(await findByText(/does not use an account service/)).toBeTruthy();
  expect(complete).not.toHaveBeenCalled();
});
