import { test, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import Status from "./status.svelte";

afterEach(cleanup);

test("badge form: lowercase mono chip on the status token", () => {
  const { container } = render(Status, { props: { status: "Running" } });
  const el = container.querySelector("[data-status]") as HTMLElement;

  expect(el.dataset.status).toBe("running");
  expect(el.textContent).toBe("running");
  expect(el.className).toContain("font-mono");
  expect(el.className).toContain("bg-status-running/10");
});

test("normalizes upstream vocab: online→running, banned→error, unknown→stopped", () => {
  for (const [raw, token] of [
    ["online", "running"],
    ["banned", "error"],
    ["totally-unknown", "stopped"],
  ] as const) {
    const { container, unmount } = render(Status, { props: { status: raw, form: "text" } });
    expect((container.querySelector("[data-status]") as HTMLElement).dataset.status).toBe(token);
    unmount();
  }
});

test("degraded is a first-class token — never collapsed to stopped", () => {
  const { container } = render(Status, { props: { status: "degraded", form: "cell" } });
  const el = container.querySelector("[data-status]") as HTMLElement;

  expect(el.dataset.status).toBe("degraded");
  expect(el.className).toContain("bg-status-degraded");
  expect(el.className).not.toContain("bg-status-stopped");
});

test("dot form carries a screen-reader label", () => {
  const { container } = render(Status, {
    props: { status: "connecting", form: "dot", label: "Connecting…" },
  });

  expect(container.querySelector(".sr-only")?.textContent).toBe("connecting…");
  expect(container.querySelector('[aria-hidden="true"]')?.className).toContain("rounded-full");
});

test("cell form is an accessible solid square", () => {
  const { getByRole } = render(Status, {
    props: { status: "error", form: "cell", label: "api-agent (error)" },
  });

  const cell = getByRole("img");
  expect(cell.getAttribute("aria-label")).toBe("api-agent (error)");
  expect(cell.className).toContain("bg-status-error");
});
