import { test, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";
import StateBar from "./StateBar.svelte";

afterEach(cleanup);

test("renders one segment per non-zero state, worst-first", () => {
  const { container } = render(StateBar, { props: { counts: { running: 12, stopped: 3 } } });
  const segments = container.querySelectorAll('[role="group"] > button');

  expect(segments).toHaveLength(2);
  // STATE_ORDER is worst-first: running (index 3) sorts before stopped (index 5).
  expect(segments[0].getAttribute("title")).toBe("Running: 12");
  expect(segments[1].getAttribute("title")).toBe("Stopped: 3");
});

test("segment width is proportional to its share of the total", () => {
  const { container } = render(StateBar, { props: { counts: { running: 12, stopped: 3 } } });
  const segments = container.querySelectorAll('[role="group"] > button') as NodeListOf<HTMLElement>;

  expect(segments[0].style.flexBasis).toBe("80%");
  expect(segments[1].style.flexBasis).toBe("20%");
});

test("zero-count states are absent from both the bar and the legend", () => {
  const { container, queryByText } = render(StateBar, {
    props: { counts: { running: 5, error: 0, stopped: undefined } },
  });

  expect(container.querySelectorAll('[role="group"] > button')).toHaveLength(1);
  expect(queryByText("Error")).toBeNull();
  expect(queryByText("Stopped")).toBeNull();
});

test("the legend lists both states with dot, label and count", () => {
  const { container, getByText } = render(StateBar, {
    props: { counts: { running: 12, stopped: 3 } },
  });
  const legend = container.querySelector("ul") as HTMLElement;

  expect(getByText("Running")).toBeTruthy();
  expect(getByText("Stopped")).toBeTruthy();
  // counts appear in the legend as their own mono text
  const legendText = legend.textContent ?? "";
  expect(legendText).toContain("12");
  expect(legendText).toContain("3");
});

test("a segment over 7% shows its count inside the bar", () => {
  const { container } = render(StateBar, { props: { counts: { running: 95, error: 5 } } });
  const buttons = container.querySelectorAll('[role="group"] > button') as NodeListOf<HTMLElement>;
  const runningSegment = Array.from(buttons).find((b) => b.getAttribute("title")?.startsWith("Running"));

  expect(runningSegment?.textContent?.trim()).toBe("95");
});

test("a segment at or under 7% shows no count inside the bar, only in the legend", () => {
  const { container } = render(StateBar, { props: { counts: { running: 95, error: 5 } } });
  const buttons = container.querySelectorAll('[role="group"] > button') as NodeListOf<HTMLElement>;
  const errorSegment = Array.from(buttons).find((b) => b.getAttribute("title")?.startsWith("Error"));

  expect(errorSegment?.textContent?.trim()).toBe("");
});

test("clicking a bar segment calls onselect with its state id", async () => {
  const onselect = vi.fn();
  const { container } = render(StateBar, {
    props: { counts: { running: 1, stopped: 1 }, onselect },
  });
  const buttons = container.querySelectorAll('[role="group"] > button');

  await fireEvent.click(buttons[0]);
  expect(onselect).toHaveBeenCalledWith("running");
});

test("clicking a legend row calls onselect with its state id", async () => {
  const onselect = vi.fn();
  const { container } = render(StateBar, {
    props: { counts: { running: 1, stopped: 1 }, onselect },
  });
  const legendButtons = container.querySelectorAll("ul button");

  await fireEvent.click(legendButtons[1]);
  expect(onselect).toHaveBeenCalledWith("stopped");
});
