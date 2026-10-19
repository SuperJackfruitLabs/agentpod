import { afterEach, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import { toast } from "svelte-sonner";
import { flushSync } from "svelte";
import { Toaster } from "./index";
import { appearance } from "$lib/appearance.svelte";

// Regression: the toaster took its theme from mode-watcher, which was never mounted, so it
// followed the OS instead of the console. It follows the appearance (data-theme) now.
describe("Toaster", () => {
  afterEach(() => {
    appearance.dispose();
    document.cookie = "vk_appearance=; Max-Age=0; Path=/";
    toast.dismiss();
  });

  it("follows the appearance's theme, and changes with it", async () => {
    document.cookie = "vk_appearance=daylight.dark.strong.0; Path=/";
    appearance.init();
    const { container } = render(Toaster);
    toast("Saved");
    await waitFor(() => expect(container.querySelector("[data-sonner-theme]")).not.toBeNull());
    expect(container.querySelector("[data-sonner-theme]")!.getAttribute("data-sonner-theme")).toBe("dark");

    appearance.set({ theme: "light" });
    flushSync();
    await waitFor(() =>
      expect(container.querySelector("[data-sonner-theme]")!.getAttribute("data-sonner-theme")).toBe("light"),
    );
  });
});
