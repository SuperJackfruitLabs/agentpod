/**
 * status-badge.test.ts
 *
 * Unit tests for statusBadgeClass / statusTextClass / statusBgClass — the
 * theme-robust status helpers built on the `--status-*` design tokens
 * (Plan A). Each helper is a full-literal Tailwind class lookup (no string
 * interpolation) so the classes remain scannable by Tailwind's JIT.
 *
 * Run: cd apps/console && pnpm test status-badge
 */

import { test, expect, describe } from "vitest";
import { statusBadgeClass, statusTextClass, statusBgClass } from "./status-badge";

// Status → expected token groupings, mirroring tokenFor() in status-badge.ts
const GROUPS: Record<string, string[]> = {
  running: ["running", "online", "healthy", "active", "connected"],
  error: ["error", "unhealthy", "crashed"],
  starting: ["starting", "stopping", "warning", "pending"],
  degraded: ["degraded"],
  sleeping: ["sleeping", "hibernated"],
  stopped: ["stopped", "offline", "unknown", "something-random"],
};

describe("statusBadgeClass", () => {
  for (const [token, statuses] of Object.entries(GROUPS)) {
    for (const status of statuses) {
      test(`${status} → status-${token} outline (full literal)`, () => {
        const cls = statusBadgeClass(status);
        expect(cls).toContain(`text-status-${token}`);
        expect(cls).toContain(`border-status-${token}`);
        expect(cls).toContain(`bg-status-${token}/10`);
      });
    }
  }

  test("case normalization: RUNNING (uppercase) → status-running", () => {
    expect(statusBadgeClass("RUNNING")).toContain("text-status-running");
  });

  test("case normalization: Connected (mixed-case) → status-running", () => {
    expect(statusBadgeClass("Connected")).toContain("text-status-running");
  });

  test("returns exactly the full literal string for running", () => {
    expect(statusBadgeClass("running")).toBe(
      "text-status-running border-status-running bg-status-running/10",
    );
  });

  test("returns exactly the full literal string for degraded", () => {
    expect(statusBadgeClass("degraded")).toBe(
      "text-status-degraded border-status-degraded bg-status-degraded/10",
    );
  });
});

describe("statusTextClass", () => {
  for (const [token, statuses] of Object.entries(GROUPS)) {
    test(`${statuses[0]} → text-status-${token} only`, () => {
      const cls = statusTextClass(statuses[0]);
      expect(cls).toBe(`text-status-${token}`);
    });
  }

  test("case normalization applies", () => {
    expect(statusTextClass("ERROR")).toBe("text-status-error");
  });
});

describe("statusBgClass", () => {
  for (const [token, statuses] of Object.entries(GROUPS)) {
    test(`${statuses[0]} → bg-status-${token} (solid)`, () => {
      const cls = statusBgClass(statuses[0]);
      expect(cls).toBe(`bg-status-${token}`);
    });
  }

  test("case normalization applies", () => {
    expect(statusBgClass("SLEEPING")).toBe("bg-status-sleeping");
  });
});
