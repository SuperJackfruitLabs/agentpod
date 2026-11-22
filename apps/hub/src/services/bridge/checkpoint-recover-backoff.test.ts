import { expect, test } from "bun:test";
import { createAttemptBackoff } from "./checkpoint-recover-backoff";

test("an attempt parked again waits twice as long, to a ceiling; another attempt or a clear starts over", () => {
  let t = 0;
  const b = createAttemptBackoff({ now: () => t, baseMs: 10, maxMs: 35 });
  expect(b.due("a")).toBe(true);
  b.parked("a");
  t = 9; expect(b.due("a")).toBe(false);
  t = 10; expect(b.due("a")).toBe(true);
  b.parked("a"); // next at 30
  t = 29; expect(b.due("a")).toBe(false);
  t = 30; expect(b.due("a")).toBe(true);
  b.parked("a"); // 40 would be 30 + 40, capped at 35 → 65
  t = 64; expect(b.due("a")).toBe(false);
  t = 65; expect(b.due("a")).toBe(true);
  // A different attempt is never held by this one's backoff.
  b.parked("a");
  expect(b.due("b")).toBe(true);
  b.clear();
  expect(b.due("a")).toBe(true);
});

test("a run still going waits only its recheck, says how long is left, and does not grow the fault backoff", () => {
  let t = 0;
  const b = createAttemptBackoff({ now: () => t });
  b.parked("a", 5_000);
  expect(b.due("a")).toBe(false);
  expect(b.recheckIn("a")).toBe(5_000);
  t = 5_000;
  expect(b.due("a")).toBe(true);
  b.parked("a", 5_000);
  t = 10_000;
  expect(b.due("a")).toBe(true);
  // The first fault after it starts from the base, as if no park had come before.
  b.parked("a");
  expect(b.recheckIn("a")).toBeUndefined();
  t = 10_000 + 29_999;
  expect(b.due("a")).toBe(false);
  t = 10_000 + 30_000;
  expect(b.due("a")).toBe(true);
});
