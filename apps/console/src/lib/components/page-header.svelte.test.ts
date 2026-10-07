import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/svelte";
import PageHeader from "./page-header-test-host.svelte";

describe("PageHeader", () => {
  it("renders title, subtitle, and status with token classes", () => {
    render(PageHeader, {
      title: "hermes-01",
      subtitle: "~/projects/hermes",
      status: { label: "Running", variant: "running" },
    });
    expect(screen.getByRole("heading", { name: "hermes-01" })).toBeTruthy();
    expect(screen.getByText("~/projects/hermes")).toBeTruthy();
    // Status renders through the shared <Status> component: lowercase mono.
    const badge = screen.getByText("running");
    expect(badge.closest("[class*='text-status-running']")).toBeTruthy();
    expect(badge.className).toContain("font-mono");
  });

  it("fires onTabChange when an enabled tab is clicked, not for disabled tabs", async () => {
    const onTabChange = vi.fn();
    render(PageHeader, {
      title: "t",
      tabs: [
        { id: "health", label: "Health" },
        { id: "files", label: "Files", disabled: true, disabledReason: "No capability" },
      ],
      activeTab: "health",
      onTabChange,
    });
    await fireEvent.click(screen.getByRole("tab", { name: /health/i }));
    expect(onTabChange).toHaveBeenCalledWith("health");
    await fireEvent.click(screen.getByRole("tab", { name: /files/i }));
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });

  it("supports arrow-key navigation and keeps disabled tabs focusable with aria-disabled", async () => {
    const onTabChange = vi.fn();
    render(PageHeader, {
      title: "t",
      tabs: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta", disabled: true, disabledReason: "locked" },
        { id: "c", label: "Gamma" },
      ],
      activeTab: "a",
      onTabChange,
    });
    const alpha = screen.getByRole("tab", { name: /alpha/i });
    const beta = screen.getByRole("tab", { name: /beta/i });
    expect(beta.getAttribute("aria-disabled")).toBe("true");
    expect(beta.hasAttribute("disabled")).toBe(false);
    alpha.focus();
    await fireEvent.keyDown(alpha, { key: "ArrowRight" });
    expect(document.activeElement).toBe(beta); // focus moves; activation does not
    await fireEvent.click(beta);
    expect(onTabChange).not.toHaveBeenCalled();
    await fireEvent.keyDown(beta, { key: "ArrowRight" });
    await fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(onTabChange).toHaveBeenCalledWith("c");
  });
});

// ─── narrow screens ─────────────────────────────────────────────────────────
// At 390px a header with three actions wrapped to 163px — 19% of the screen,
// stuck to the top (responsive audit, 2026-10-07). Below 640px the secondary
// actions fold into one "More actions" menu so the header stays one row.

function viewport(width: number) {
  window.matchMedia = ((query: string) => {
    const max = /\(max-width:\s*(\d+)px\)/.exec(query);
    const min = /\(min-width:\s*(\d+)px\)/.exec(query);
    const matches = max ? width <= Number(max[1]) : min ? width >= Number(min[1]) : false;
    return {
      matches, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}

describe("PageHeader secondary actions", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it("sit inline as buttons on a wide screen", () => {
    viewport(1280);
    const onSelect = vi.fn();
    render(PageHeader, { title: "Nodes", secondaryActions: [{ label: "New runtime", onSelect }] });
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    screen.getByRole("button", { name: "New runtime" }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("fold into a More actions menu on a phone, and still run from there", async () => {
    viewport(390);
    const onSelect = vi.fn();
    render(PageHeader, {
      title: "Nodes",
      secondaryActions: [
        { label: "Update 2 nodes", onSelect: vi.fn() },
        { label: "New runtime", onSelect },
      ],
    });
    expect(screen.queryByRole("button", { name: "New runtime" })).toBeNull();
    const more = screen.getByRole("button", { name: "More actions" });

    await fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    await fireEvent.keyDown(more, { key: "Enter" });
    const item = await screen.findByRole("menuitem", { name: "New runtime" });
    await fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("puts the title and the actions on one row, wrapping only if they cannot fit", () => {
    viewport(390);
    const { container } = render(PageHeader, { title: "Nodes", secondaryActions: [] });
    const row = container.querySelector("[data-testid='page-header-row']")!;
    expect(row.className).not.toContain("flex-col");
  });
});
