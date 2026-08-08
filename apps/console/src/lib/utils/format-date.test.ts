/**
 * format-date.test.ts
 *
 * Unit tests for formatDate(iso, style) — consolidates the two page-local
 * `formatDate` helpers previously duplicated between the admin users list
 * (short: "Jun 29, 2026") and the admin user detail page (long: "June 29,
 * 2026" + time). Both use `toLocaleDateString(undefined, {...})`, so these
 * tests use noon UTC input to stay stable across reasonable test-runner
 * timezones (the date portion can't roll to an adjacent day) and assert the
 * locale-stable pieces rather than the exact time string.
 *
 * Run: cd apps/console && pnpm test format-date
 */

import { test, expect, describe } from "vitest";
import { formatDate } from "./format-date";

const ISO = "2026-06-29T12:00:00Z";

describe("formatDate", () => {
  test("defaults to short style: 'Jun 29, 2026'", () => {
    expect(formatDate(ISO)).toBe("Jun 29, 2026");
  });

  test("short style explicit", () => {
    expect(formatDate(ISO, "short")).toBe("Jun 29, 2026");
  });

  test("long style: full month name + day + year + time", () => {
    const result = formatDate(ISO, "long");
    expect(result).toContain("June 29, 2026");
    expect(result).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)?/i);
  });
});
