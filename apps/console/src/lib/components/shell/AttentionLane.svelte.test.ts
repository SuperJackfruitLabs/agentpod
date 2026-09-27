/**
 * AttentionLane.svelte.test.ts
 *
 * The lane renders whatever deriveAttention hands it — including nothing,
 * which is the state it is proudest of.
 */
import { test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import type { AttentionItem } from "$lib/fleet/attention";
import AttentionLane from "./AttentionLane.svelte";

const items: AttentionItem[] = [
  {
    kind: "node-offline",
    token: "error",
    what: "Node offline",
    who: "node-alpha",
    detail: "3 agents unknown",
    href: "/nodes/n1",
  },
  {
    kind: "runtime-error",
    token: "error",
    what: "Runtime failed to start",
    who: "rt-quill",
    detail: "image pull failed",
    href: "/runtimes",
  },
  {
    kind: "drift",
    token: "unknown",
    what: "Node agent is behind",
    who: "node-beta",
    detail: "0.4.1 to 0.5.0",
    href: "/nodes/n2",
  },
];

test("with no items the lane says so in words", () => {
  const { getByText } = render(AttentionLane, { props: { items: [] } });

  expect(getByText("Nothing needs you. The fleet is running itself.")).toBeTruthy();
});

test("the count badge shows 0 as an outline when nothing needs a human", () => {
  const { getByTestId } = render(AttentionLane, { props: { items: [] } });
  const badge = getByTestId("attention-count");

  expect(badge.textContent?.trim()).toBe("0");
  expect(badge.className).toContain("border");
  expect(badge.className).not.toContain("bg-status-unknown");
});

test("N items render N clickable entries carrying their what and who", () => {
  const { getAllByTestId } = render(AttentionLane, { props: { items } });
  const entries = getAllByTestId("attention-item");

  expect(entries).toHaveLength(3);
  expect(entries[0].textContent).toContain("Node offline");
  expect(entries[0].textContent).toContain("node-alpha");
  expect(entries[0].getAttribute("href")).toBe("/nodes/n1");
  expect(entries[1].textContent).toContain("Runtime failed to start");
  expect(entries[1].textContent).toContain("rt-quill");
  expect(entries[2].textContent).toContain("Node agent is behind");
  expect(entries[2].textContent).toContain("node-beta");
});

test("the count badge shows N and fills when something needs a human", () => {
  const { getByTestId } = render(AttentionLane, { props: { items } });
  const badge = getByTestId("attention-count");

  expect(badge.textContent?.trim()).toBe("3");
  expect(badge.className).toContain("bg-status-unknown");
});

test("the machine-issued name is mono, the condition is not", () => {
  const { getAllByTestId } = render(AttentionLane, { props: { items } });
  const who = getAllByTestId("attention-item")[0].querySelector(".font-mono");

  expect(who?.textContent).toBe("node-alpha");
});

test("the empty lane renders no items", () => {
  const { queryAllByTestId } = render(AttentionLane, { props: { items: [] } });

  expect(queryAllByTestId("attention-item")).toHaveLength(0);
});

test("each item is a containing block, so the sr-only labels cannot escape the scroller", () => {
  const { getAllByTestId } = render(AttentionLane, { props: { items } });

  // StateDot's sr-only word is position:absolute. Without a positioned
  // ancestor its containing block is the initial one, so it escapes this
  // scroller's clip and adds its static x-position to the DOCUMENT's scroll
  // width — 1828px on a 1500px viewport with five real items, measured, past
  // every overflow:hidden in the shell.
  expect(getAllByTestId("attention-item")[0].classList.contains("relative")).toBe(true);
});

test("the item list is its own horizontal scroll container, never the page's", () => {
  const { getByTestId } = render(AttentionLane, { props: { items } });

  // Constraint 7: wide content scrolls in its own container. min-w-0 is what
  // stops this flex list from setting the shell's width to its content width.
  expect(getByTestId("attention-items").className).toContain("overflow-x-auto");
  expect(getByTestId("attention-items").className).toContain("min-w-0");
});
