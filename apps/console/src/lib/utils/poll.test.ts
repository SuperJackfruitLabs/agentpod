import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { startPolling } from "./poll";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

test("polls on the interval while visible", () => {
  setHidden(false);
  const fn = vi.fn();
  const stop = startPolling(fn, 1000);

  vi.advanceTimersByTime(3000);
  expect(fn).toHaveBeenCalledTimes(3);
  stop();
});

test("skips ticks while the tab is hidden, fires immediately on return", () => {
  setHidden(false);
  const fn = vi.fn();
  const stop = startPolling(fn, 1000);

  setHidden(true);
  vi.advanceTimersByTime(5000);
  expect(fn).not.toHaveBeenCalled();

  setHidden(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(fn).toHaveBeenCalledTimes(1);
  stop();
});

test("stop() halts the interval and removes the listener", () => {
  setHidden(false);
  const fn = vi.fn();
  const stop = startPolling(fn, 1000);
  stop();

  vi.advanceTimersByTime(5000);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(fn).not.toHaveBeenCalled();
});
