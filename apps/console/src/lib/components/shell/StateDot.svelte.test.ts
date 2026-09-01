import { test, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import StateDot from "./StateDot.svelte";
import { STATE } from "$lib/fleet/state";

afterEach(cleanup);

test("renders the bg-status-{token} dot for the given state", () => {
  const { container } = render(StateDot, { props: { state: STATE.error } });
  const dot = container.querySelector("span[aria-hidden]") as HTMLElement;

  expect(dot.className).toContain("bg-status-error");
});

test("without withLabel, the word is not visible but is present for assistive tech", () => {
  const { container, queryByText } = render(StateDot, { props: { state: STATE.running } });

  expect(queryByText("Running", { selector: "span:not(.sr-only)" })).toBeNull();
  expect(container.querySelector(".sr-only")?.textContent).toBe("Running");
});

test("withLabel renders the label as visible text", () => {
  const { container } = render(StateDot, { props: { state: STATE.stopped, withLabel: true } });

  expect(container.querySelector(".sr-only")).toBeNull();
  expect(container.textContent).toContain("Stopped");
});

test("title always carries the label, whether or not withLabel is set", () => {
  const { container: withoutLabel } = render(StateDot, { props: { state: STATE.sleeping } });
  expect(withoutLabel.querySelector("[title]")?.getAttribute("title")).toBe("Sleeping");
  cleanup();

  const { container: withLabel } = render(StateDot, {
    props: { state: STATE.sleeping, withLabel: true },
  });
  expect(withLabel.querySelector("[title]")?.getAttribute("title")).toBe("Sleeping");
});

test("pulse adds animate-pulse to the dot", () => {
  const { container } = render(StateDot, { props: { state: STATE.starting, pulse: true } });
  const dot = container.querySelector("span[aria-hidden]") as HTMLElement;

  expect(dot.className).toContain("animate-pulse");
});

test("pulse is opt-in: absent by default", () => {
  const { container } = render(StateDot, { props: { state: STATE.starting } });
  const dot = container.querySelector("span[aria-hidden]") as HTMLElement;

  expect(dot.className).not.toContain("animate-pulse");
});

test("size sm renders a smaller dot than size md", () => {
  const { container: sm } = render(StateDot, { props: { state: STATE.running, size: "sm" } });
  const smDot = sm.querySelector("span[aria-hidden]") as HTMLElement;
  expect(smDot.className).toContain("size-1.5");
  cleanup();

  const { container: md } = render(StateDot, { props: { state: STATE.running, size: "md" } });
  const mdDot = md.querySelector("span[aria-hidden]") as HTMLElement;
  expect(mdDot.className).toContain("size-2");
});
