import { test, expect, afterEach, vi } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/svelte";
// Static import: compiled during file collection, not during the test body.
import PermissionCard from "./PermissionCard.svelte";
import type { ChatItem } from "./transcript";

afterEach(() => cleanup());

type PermissionItem = Extract<ChatItem, { kind: "permission" }>;

function permissionItem(overrides: Partial<PermissionItem> = {}): PermissionItem {
  return {
    kind: "permission",
    seq: 3,
    requestSeq: 3,
    title: "Bash(rm -rf build)",
    toolKind: "execute",
    options: [
      { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "opt-reject-once", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

// ── Unanswered ───────────────────────────────────────────────────────────────

test("unanswered: pulsing dot with awaiting-approval label and mono title", () => {
  const { container, getByText } = render(PermissionCard, {
    props: { item: permissionItem(), onAnswer: vi.fn() },
  });

  const dot = container.querySelector("[data-status]");
  expect(dot?.getAttribute("data-status")).toBe("starting");
  expect(dot?.querySelector(".motion-safe\\:animate-pulse")).not.toBeNull();
  expect(getByText("awaiting approval")).toBeTruthy();

  const title = getByText("Bash(rm -rf build)");
  expect(title.classList.contains("font-mono")).toBe(true);
});

test("all options render as real, focusable buttons in order", () => {
  const { getAllByRole } = render(PermissionCard, {
    props: { item: permissionItem(), onAnswer: vi.fn() },
  });

  const buttons = getAllByRole("button");
  expect(buttons.length).toBe(3);
  expect(buttons.map((b) => b.textContent?.trim())).toEqual([
    "Allow once",
    "Always allow",
    "Reject",
  ]);
  for (const b of buttons) {
    expect(b.tagName).toBe("BUTTON");
    // Real buttons are keyboard focusable (no tabindex=-1).
    expect(b.getAttribute("tabindex")).not.toBe("-1");
  }
});

test("variant mapping: first allow → default, second allow → secondary, reject → outline", () => {
  const { getAllByRole } = render(PermissionCard, {
    props: { item: permissionItem(), onAnswer: vi.fn() },
  });

  const [first, second, reject] = getAllByRole("button");
  expect(first.className).toContain("bg-primary");
  expect(second.className).toContain("bg-secondary");
  expect(reject.className).toContain("border-border");
  expect(reject.className).not.toContain("bg-primary");
});

test("clicking an option calls onAnswer with its optionId", async () => {
  const onAnswer = vi.fn();
  const { getByText } = render(PermissionCard, {
    props: { item: permissionItem(), onAnswer },
  });

  await fireEvent.click(getByText("Always allow"));

  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect(onAnswer).toHaveBeenCalledWith("opt-allow-always");
});

test("reject options are regular buttons that answer with their optionId", async () => {
  const onAnswer = vi.fn();
  const { getByText } = render(PermissionCard, {
    props: { item: permissionItem(), onAnswer },
  });

  await fireEvent.click(getByText("Reject"));

  expect(onAnswer).toHaveBeenCalledWith("opt-reject-once");
});

// ── Answered ─────────────────────────────────────────────────────────────────

test("answered: buttons gone, chosen option name shown", () => {
  const { queryAllByRole, getByText } = render(PermissionCard, {
    props: {
      item: permissionItem({ answer: { optionId: "opt-allow-once" } }),
      onAnswer: vi.fn(),
    },
  });

  expect(queryAllByRole("button").length).toBe(0);
  expect(getByText(/Allow once/)).toBeTruthy();
});

test("answered with auto shows the · auto suffix", () => {
  const { container } = render(PermissionCard, {
    props: {
      item: permissionItem({ answer: { optionId: "opt-allow-always", auto: true } }),
      onAnswer: vi.fn(),
    },
  });

  expect(container.textContent).toContain("Always allow");
  expect(container.textContent).toContain("· auto");
});

test("cancelled shows Cancelled. and no buttons", () => {
  const { container, queryAllByRole } = render(PermissionCard, {
    props: {
      item: permissionItem({ answer: { cancelled: true } }),
      onAnswer: vi.fn(),
    },
  });

  expect(queryAllByRole("button").length).toBe(0);
  expect(container.textContent).toContain("Cancelled.");
});

test("answered with an optionId missing from options falls back to the raw id", () => {
  const { container } = render(PermissionCard, {
    props: {
      item: permissionItem({ answer: { optionId: "opt-unknown" } }),
      onAnswer: vi.fn(),
    },
  });
  expect(container.textContent).toContain("opt-unknown");
});

test("answered card no longer shows the awaiting-approval dot", () => {
  const { container, queryByText } = render(PermissionCard, {
    props: {
      item: permissionItem({ answer: { optionId: "opt-allow-once" } }),
      onAnswer: vi.fn(),
    },
  });
  expect(queryByText("awaiting approval")).toBeNull();
  expect(container.querySelector(".motion-safe\\:animate-pulse")).toBeNull();
});
