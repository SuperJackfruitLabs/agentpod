import { test, expect, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
// Static import: compiled during file collection, not during the test body.
import Reasoning from "./Reasoning.svelte";

afterEach(() => cleanup());

function trigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-slot='collapsible-trigger']");
  if (!el) throw new Error("collapsible trigger not rendered");
  return el;
}

test("renders the Thinking trigger label", () => {
  const { getByText } = render(Reasoning, { props: { text: "pondering", streaming: false } });
  expect(getByText("Thinking")).toBeTruthy();
});

test("open while streaming: thought text and pulsing dot are visible", () => {
  const { container, getByText } = render(Reasoning, {
    props: { text: "step 1: look at the file", streaming: true },
  });

  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
  expect(getByText(/step 1: look at the file/)).toBeTruthy();
  // Status dot carries an sr-only label while streaming.
  expect(getByText("thinking")).toBeTruthy();
});

test("auto-collapses when streaming flips true → false", async () => {
  const { container, rerender } = render(Reasoning, {
    props: { text: "step 1", streaming: true },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");

  await rerender({ text: "step 1 done", streaming: false });

  await waitFor(() => {
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });
});

test("collapses exactly once: manual re-expand survives later non-streaming updates", async () => {
  const { container, rerender } = render(Reasoning, {
    props: { text: "step 1", streaming: true },
  });

  await rerender({ text: "step 1 done", streaming: false });
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("false"));

  // Reader re-opens the block…
  await fireEvent.click(trigger(container));
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("true"));

  // …and a later prop update (still not streaming) must NOT re-collapse it.
  await rerender({ text: "step 1 done", streaming: false });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
});

test("re-opens on a new streaming segment: true → false (collapsed) → true", async () => {
  const { container, rerender } = render(Reasoning, {
    props: { text: "block 1", streaming: true },
  });

  // Block 1 finishes: auto-collapse. User leaves it collapsed.
  await rerender({ text: "block 1", streaming: false });
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("false"));

  // The instance is reused for a fresh reasoning segment — false→true edge
  // must re-open so new thinking content is not accumulating invisibly.
  await rerender({ text: "block 2 begins", streaming: true });
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("true"));
});

test("manual collapse mid-stream is not fought by same-state updates", async () => {
  const { container, rerender } = render(Reasoning, {
    props: { text: "quiet", streaming: false },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("false");

  // false→true edge opens the block.
  await rerender({ text: "thinking...", streaming: true });
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("true"));

  // User collapses it mid-stream…
  await fireEvent.click(trigger(container));
  await waitFor(() => expect(trigger(container).getAttribute("aria-expanded")).toBe("false"));

  // …and streaming text keeps arriving (streaming stays true — no edge):
  // the block must stay collapsed, not pop back open.
  await rerender({ text: "thinking... more", streaming: true });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
});

test("starts collapsed when not streaming; manual expand reveals plain text", async () => {
  const { container, getByText } = render(Reasoning, {
    props: { text: "already finished thought", streaming: false },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("false");

  await fireEvent.click(trigger(container));

  await waitFor(() => expect(getByText(/already finished thought/)).toBeTruthy());
  // Thoughts are plain text, not markdown — rendered pre-wrapped, no <strong>.
  const content = container.querySelector("[data-testid='reasoning-content']");
  expect(content?.classList.contains("whitespace-pre-wrap")).toBe(true);
});
