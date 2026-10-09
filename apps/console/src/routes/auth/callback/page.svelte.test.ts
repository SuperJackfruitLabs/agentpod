import { render, waitFor } from "@testing-library/svelte";
import { beforeEach, expect, test, vi } from "vitest";
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
import { goto } from "$app/navigation";
import * as plane from "$lib/auth/org-plane";
import * as authStore from "$lib/stores/auth.svelte";
import * as library from "$lib/auth/superlibrary-grant";
import Page from "./+page.svelte";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(goto).mockReset();
});

test("completes the sign-in and goes to where the user was going", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  vi.spyOn(plane, "completeSignIn").mockResolvedValue({ returnTo: "/nodes" });
  const init = vi.spyOn(authStore, "initAuth").mockResolvedValue();
  vi.spyOn(authStore.auth, "isAuthenticated", "get").mockReturnValue(true);
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

test("a silent authorize the plane could not answer silently goes on to an interactive one", async () => {
  const P = { issuer: "i", url: "https://accounts.test", audience: "a" };
  vi.spyOn(authStore, "currentPlane").mockReturnValue(P);
  vi.spyOn(plane, "completeSignIn").mockResolvedValue({ returnTo: "/nodes", interactive: true });
  const begin = vi.spyOn(plane, "beginSignIn").mockResolvedValue();
  const init = vi.spyOn(authStore, "initAuth").mockResolvedValue();
  window.history.replaceState({}, "", "/auth/callback?error=login_required&state=s");
  render(Page);
  await waitFor(() => expect(begin).toHaveBeenCalledWith(P, { returnTo: "/nodes" }));
  expect(init).not.toHaveBeenCalled();
  expect(goto).not.toHaveBeenCalled();
});

// product_not_enabled (403) and the like: the token was issued but the hub will not have it. Going
// on to the protected page would send the guard straight back to the plane, in a loop.
test("a hub that refuses the new token shows the error here instead of going on", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  vi.spyOn(plane, "completeSignIn").mockResolvedValue({ returnTo: "/nodes" });
  vi.spyOn(authStore, "initAuth").mockResolvedValue();
  vi.spyOn(authStore.auth, "isAuthenticated", "get").mockReturnValue(false);
  vi.spyOn(authStore.auth, "error", "get").mockReturnValue("The hub refused your sign-in (HTTP 403).");
  const suppress = vi.spyOn(plane, "suppressAutoSignIn");
  window.history.replaceState({}, "", "/auth/callback?code=c&state=s");
  const { findByText } = render(Page);
  expect(await findByText(/HTTP 403/)).toBeTruthy();
  expect(goto).not.toHaveBeenCalled();
  expect(suppress).toHaveBeenCalled();
});

test("Superlibrary's sign-in window hands its answer to the page that opened it, and is never the hub's sign-in", async () => {
  vi.spyOn(authStore, "currentPlane").mockReturnValue({ issuer: "i", url: "u", audience: "a" });
  const relay = vi.spyOn(library, "relaySuperlibraryCallback").mockReturnValue(true);
  const complete = vi.spyOn(plane, "completeSignIn");
  window.history.replaceState({}, "", "/auth/callback?code=c&state=sl.abc");
  const { findByText } = render(Page);
  expect(await findByText(/Superlibrary/)).toBeTruthy();
  expect(relay).toHaveBeenCalledWith("?code=c&state=sl.abc");
  expect(complete).not.toHaveBeenCalled();
  expect(goto).not.toHaveBeenCalled();
});
