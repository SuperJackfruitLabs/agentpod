import { test, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import StatusRibbon from "./StatusRibbon.svelte";

afterEach(cleanup);

const items = [
  { id: "a", label: "hermes-1", status: "running" },
  { id: "b", label: "claw-2", status: "degraded" },
  { id: "c", label: "codex-3", status: "error" },
  { id: "d", label: "mystery", status: "unknown" },
];

test("renders one cell per item on the full six-token vocabulary", () => {
  const { getAllByTestId } = render(StatusRibbon, { props: { items } });
  const cells = getAllByTestId("ribbon-cell");

  expect(cells).toHaveLength(4);
  // data-status keeps the RAW status (legend/filter semantics); the color
  // class comes from the token. Regression: degraded used to fall through to
  // the same class as unknown.
  expect(cells[1].dataset.status).toBe("degraded");
  expect(cells[1].className).toContain("bg-status-degraded");
  expect(cells[3].dataset.status).toBe("unknown");
  expect(cells[3].className).toContain("bg-status-stopped");
  expect(cells[1].className).not.toBe(cells[3].className);
});

test("error cells carry hue-independent emphasis (colorblind-safe ring)", () => {
  const { getAllByTestId } = render(StatusRibbon, { props: { items, size: "lg" } });
  const cells = getAllByTestId("ribbon-cell");

  expect(cells[2].className).toContain("ring-2");
  expect(cells[0].className).not.toContain("ring-2");
});

test("xs strip drops the emphasis ring (chrome, not chart)", () => {
  const { getAllByTestId } = render(StatusRibbon, { props: { items, size: "xs" } });
  expect(getAllByTestId("ribbon-cell")[2].className).not.toContain("ring-2");
});

test("interactive when onSelect is provided: buttons with accessible names", () => {
  const onSelect = vi.fn();
  const { getByRole } = render(StatusRibbon, { props: { items, size: "lg", onSelect } });

  const cell = getByRole("button", { name: "claw-2 (degraded)" });
  fireEvent.click(cell);
  expect(onSelect).toHaveBeenCalledWith("b");
});

test("non-interactive cells are labeled images, not buttons", () => {
  const { queryAllByRole, getAllByRole } = render(StatusRibbon, { props: { items } });

  expect(queryAllByRole("button")).toHaveLength(0);
  expect(getAllByRole("img")).toHaveLength(4);
});
