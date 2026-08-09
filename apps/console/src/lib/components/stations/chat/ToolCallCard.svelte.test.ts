import { test, expect, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/svelte";
// Static import: compiled during file collection, not during the test body.
import ToolCallCard from "./ToolCallCard.svelte";
import type { ChatItem } from "./transcript";

afterEach(() => cleanup());

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

function toolItem(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    seq: 1,
    toolCallId: "tc-1",
    title: "read_file(src/main.ts)",
    toolKind: "read",
    status: "pending",
    content: [{ type: "text", text: "tool output" }],
    locations: [],
    ...overrides,
  };
}

function trigger(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-slot='collapsible-trigger']");
  if (!el) throw new Error("collapsible trigger not rendered");
  return el;
}

function statusDot(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-status]");
  if (!el) throw new Error("status dot not rendered");
  return el;
}

// ── Status dot mapping ───────────────────────────────────────────────────────

test("pending maps to the starting token without pulse", () => {
  const { container } = render(ToolCallCard, { props: { item: toolItem({ status: "pending" }) } });
  const dot = statusDot(container);
  expect(dot.getAttribute("data-status")).toBe("starting");
  expect(dot.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
});

test("in_progress maps to the starting token WITH pulse", () => {
  const { container } = render(ToolCallCard, {
    props: { item: toolItem({ status: "in_progress" }) },
  });
  const dot = statusDot(container);
  expect(dot.getAttribute("data-status")).toBe("starting");
  expect(dot.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
});

test("completed maps to the running token", () => {
  const { container } = render(ToolCallCard, {
    props: { item: toolItem({ status: "completed" }) },
  });
  expect(statusDot(container).getAttribute("data-status")).toBe("running");
});

test("failed maps to the error token", () => {
  const { container } = render(ToolCallCard, { props: { item: toolItem({ status: "failed" }) } });
  expect(statusDot(container).getAttribute("data-status")).toBe("error");
});

// ── Header ───────────────────────────────────────────────────────────────────

test("title renders in mono with the toolKind suffix", () => {
  const { container, getByText } = render(ToolCallCard, {
    props: { item: toolItem({ title: "Bash(ls -la)", toolKind: "execute" }) },
  });
  const title = getByText("Bash(ls -la)");
  expect(title.classList.contains("font-mono")).toBe(true);
  expect(container.textContent).toContain("execute");
});

// ── Collapsible behavior ─────────────────────────────────────────────────────

test("content is open by default while in_progress", () => {
  const { container, getByText } = render(ToolCallCard, {
    props: { item: toolItem({ status: "in_progress" }) },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
  expect(getByText(/tool output/)).toBeTruthy();
});

test("content is collapsed by default when completed; manual expand reveals it", async () => {
  const { container, getByText } = render(ToolCallCard, {
    props: { item: toolItem({ status: "completed" }) },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("false");

  await fireEvent.click(trigger(container));

  await waitFor(() => expect(getByText(/tool output/)).toBeTruthy());
});

test("auto-collapses on the in_progress → completed edge", async () => {
  const { container, rerender } = render(ToolCallCard, {
    props: { item: toolItem({ status: "in_progress" }) },
  });
  expect(trigger(container).getAttribute("aria-expanded")).toBe("true");

  await rerender({ item: toolItem({ status: "completed" }) });

  await waitFor(() => {
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });
});

test("no collapsible trigger when there is no content and no locations", () => {
  const { container, getByText } = render(ToolCallCard, {
    props: { item: toolItem({ content: [], locations: [] }) },
  });
  expect(container.querySelector("[data-slot='collapsible-trigger']")).toBeNull();
  // Header still renders.
  expect(getByText("read_file(src/main.ts)")).toBeTruthy();
});

// ── Content rendering ────────────────────────────────────────────────────────

test("text content renders pre-wrapped", () => {
  const { container } = render(ToolCallCard, {
    props: {
      item: toolItem({ status: "in_progress", content: [{ type: "text", text: "line1\nline2" }] }),
    },
  });
  const pre = container.querySelector("[data-testid='tool-text']");
  expect(pre).not.toBeNull();
  expect(pre!.textContent).toBe("line1\nline2");
  expect(pre!.classList.contains("whitespace-pre-wrap")).toBe(true);
});

test("diff content renders added and removed lines", () => {
  const { container } = render(ToolCallCard, {
    props: {
      item: toolItem({
        status: "in_progress",
        content: [
          { type: "diff", path: "src/app.ts", oldText: "const a = 1;\n", newText: "const a = 2;\n" },
        ],
      }),
    },
  });

  const block = container.querySelector("[data-testid='diff-block']");
  expect(block).not.toBeNull();
  expect(block!.textContent).toContain("src/app.ts");

  const added = block!.querySelector(".bg-green-500\\/15");
  const removed = block!.querySelector(".bg-red-500\\/15");
  expect(added?.textContent).toContain("const a = 2;");
  expect(removed?.textContent).toContain("const a = 1;");
});

test("diff with null oldText renders the whole newText as added", () => {
  const { container } = render(ToolCallCard, {
    props: {
      item: toolItem({
        status: "in_progress",
        content: [{ type: "diff", path: "new.ts", oldText: null, newText: "brand new\n" }],
      }),
    },
  });
  const added = container.querySelector(".bg-green-500\\/15");
  expect(added?.textContent).toContain("brand new");
  expect(container.querySelector(".bg-red-500\\/15")).toBeNull();
});

test("locations render as a file list", () => {
  const { container } = render(ToolCallCard, {
    props: {
      item: toolItem({
        status: "in_progress",
        content: [],
        locations: ["src/a.ts", "src/b.ts"],
      }),
    },
  });
  const list = container.querySelector("[data-testid='tool-locations']");
  expect(list).not.toBeNull();
  expect(list!.textContent).toContain("src/a.ts");
  expect(list!.textContent).toContain("src/b.ts");
});
