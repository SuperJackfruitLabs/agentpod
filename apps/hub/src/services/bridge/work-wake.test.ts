import { describe, expect, test } from "bun:test";

import { isWorkAvailable, onWorkAvailable, wakeBoard } from "./work-wake";

describe("waking a board's loops", () => {
  test("wakes every listener on that board, and only that board", () => {
    const woke: string[] = [];
    const offA = onWorkAvailable("brd_wake_a", () => woke.push("a1"));
    const offA2 = onWorkAvailable("brd_wake_a", () => woke.push("a2"));
    const offB = onWorkAvailable("brd_wake_b", () => woke.push("b"));
    expect(wakeBoard("brd_wake_a")).toBe(2);
    expect(woke.toSorted()).toEqual(["a1", "a2"]);
    offA();
    offA2();
    offB();
  });

  test("an unsubscribed loop is not woken", () => {
    let woke = 0;
    const off = onWorkAvailable("brd_wake_c", () => woke++);
    off();
    expect(wakeBoard("brd_wake_c")).toBe(0);
    expect(woke).toBe(0);
  });

  test("recognises only a work.available that names a board", () => {
    expect(isWorkAvailable({ event: "work.available", boardId: "brd_x" })).toBe(true);
    expect(isWorkAvailable({ event: "work.available", boardId: "" })).toBe(false);
    expect(isWorkAvailable({ event: "gate.pending", boardId: "brd_x" })).toBe(false);
    expect(isWorkAvailable(null)).toBe(false);
  });
});
