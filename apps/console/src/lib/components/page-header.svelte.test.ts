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
    const badge = screen.getByText("Running");
    expect(badge.closest("[class*='text-status-running']")).toBeTruthy();
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
});
