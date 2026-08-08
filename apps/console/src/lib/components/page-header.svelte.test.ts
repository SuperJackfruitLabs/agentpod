import { describe, expect, it, vi } from "vitest";
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
