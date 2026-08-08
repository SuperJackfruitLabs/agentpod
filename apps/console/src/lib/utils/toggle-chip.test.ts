/**
 * toggle-chip.test.ts
 *
 * Unit tests for chipClass(active, tone?) — the shared toggle-chip class
 * builder. Asserts the exact literal strings currently duplicated across
 * LogTail's level/follow/wrap toggle buttons, so adoption there produces
 * byte-identical rendered classes. Every branch is a full-literal lookup
 * (no interpolation) so Tailwind's JIT can scan the classes statically.
 *
 * Run: cd apps/console && pnpm test toggle-chip
 */

import { test, expect, describe } from "vitest";
import { chipClass } from "./toggle-chip";

const BASE = "rounded-md border px-2 py-1 whitespace-nowrap transition-colors";
const INACTIVE = "border-border text-muted-foreground hover:text-foreground";

describe("chipClass", () => {
  test("active, default tone (primary) → primary active literal", () => {
    expect(chipClass(true)).toBe(`${BASE} border-primary bg-primary/10 text-primary`);
  });

  test("active, explicit primary tone → primary active literal", () => {
    expect(chipClass(true, "primary")).toBe(`${BASE} border-primary bg-primary/10 text-primary`);
  });

  test("active, error tone → status-error active literal", () => {
    expect(chipClass(true, "error")).toBe(
      `${BASE} border-status-error bg-status-error/10 text-status-error`,
    );
  });

  test("active, degraded tone → status-degraded active literal", () => {
    expect(chipClass(true, "degraded")).toBe(
      `${BASE} border-status-degraded bg-status-degraded/10 text-status-degraded`,
    );
  });

  test("active, running tone → status-running active literal", () => {
    expect(chipClass(true, "running")).toBe(
      `${BASE} border-status-running bg-status-running/10 text-status-running`,
    );
  });

  test("active, starting tone → status-starting active literal", () => {
    expect(chipClass(true, "starting")).toBe(
      `${BASE} border-status-starting bg-status-starting/10 text-status-starting`,
    );
  });

  test("active, stopped tone → status-stopped active literal", () => {
    expect(chipClass(true, "stopped")).toBe(
      `${BASE} border-status-stopped bg-status-stopped/10 text-status-stopped`,
    );
  });

  test("active, sleeping tone → status-sleeping active literal", () => {
    expect(chipClass(true, "sleeping")).toBe(
      `${BASE} border-status-sleeping bg-status-sleeping/10 text-status-sleeping`,
    );
  });

  test("inactive, any tone → the same inactive literal (tone ignored)", () => {
    expect(chipClass(false)).toBe(`${BASE} ${INACTIVE}`);
    expect(chipClass(false, "error")).toBe(`${BASE} ${INACTIVE}`);
    expect(chipClass(false, "degraded")).toBe(`${BASE} ${INACTIVE}`);
  });
});
