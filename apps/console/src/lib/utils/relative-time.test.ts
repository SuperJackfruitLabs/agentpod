/**
 * relative-time.test.ts
 *
 * Unit tests for relativeTime(dateStr) — widened to accept `string | null`
 * so file-preview.svelte's local copy (which handled `null` → "unknown")
 * can be deleted in favor of this shared util. Existing callers
 * (RecentActivity, activity page) never pass null and keep their behavior.
 *
 * Run: cd apps/console && pnpm test relative-time
 */

import { test, expect, describe } from "vitest";
import { relativeTime } from "./relative-time";

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("relativeTime", () => {
  test("null → \"unknown\"", () => {
    expect(relativeTime(null)).toBe("unknown");
  });

  test("just now (< 1 minute ago)", () => {
    expect(relativeTime(isoAgo(10_000))).toBe("just now");
  });

  test("minutes ago", () => {
    expect(relativeTime(isoAgo(5 * 60_000))).toBe("5m ago");
  });

  test("hours ago", () => {
    expect(relativeTime(isoAgo(3 * 3_600_000))).toBe("3h ago");
  });

  test("days ago", () => {
    expect(relativeTime(isoAgo(2 * 86_400_000))).toBe("2d ago");
  });

  test("invalid date string → \"?\"", () => {
    expect(relativeTime("not-a-date")).toBe("?");
  });
});
