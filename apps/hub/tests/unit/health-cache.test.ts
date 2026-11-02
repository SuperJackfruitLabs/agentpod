/**
 * Unit Tests: InMemoryHealthCache (control-plane P2)
 *
 * Tests the in-memory health cache without any database or network access.
 * The injectable `now` parameter on recordHealth makes all timestamp assertions
 * deterministic.
 *
 * Covers:
 *   1. record → get round-trip (report + timestamp preserved).
 *   2. getHealth returns null for missing nodeId or stationKey.
 *   3. clearNode removes all stations for that node only.
 *   4. Multiple nodes are independent.
 *   5. Re-recording overwrites with the new report + timestamp.
 *   6. Multiple stations recorded in one call.
 */

import { test, expect, describe } from "bun:test";
import { InMemoryHealthCache } from "../../src/services/nodes/health-cache";
import type { StationHealthReport } from "@agentpod/contract";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReport(
  key: string,
  opts: Partial<Omit<StationHealthReport, "key">> = {}
): StationHealthReport {
  const running = opts.running ?? true;
  return {
    key,
    ok: opts.ok ?? true,
    running,
    pid: running ? 1234 : null,
    cpuPct: running ? 5.2 : null,
    memBytes: running ? 100 * 1024 * 1024 : null,
    uptimeSec: running ? 3600 : null,
    ...opts,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("InMemoryHealthCache", () => {
  test("record → get round-trip returns the report with the injected timestamp", () => {
    const cache = new InMemoryHealthCache();
    const now = 1_700_000_000_000;
    const report = makeReport("hermes-station");

    cache.recordHealth("node-1", [report], now);
    const got = cache.getHealth("node-1", "hermes-station");

    expect(got).not.toBeNull();
    expect(got!.report).toEqual(report);
    expect(got!.at).toBe(now);
  });

  test("getHealth returns null for an unknown nodeId", () => {
    const cache = new InMemoryHealthCache();
    expect(cache.getHealth("nonexistent-node", "some-key")).toBeNull();
  });

  test("getHealth returns null for a known nodeId but unknown stationKey", () => {
    const cache = new InMemoryHealthCache();
    cache.recordHealth("node-1", [makeReport("key-a")]);
    expect(cache.getHealth("node-1", "key-b")).toBeNull();
  });

  test("clearNode removes all stations for that node", () => {
    const cache = new InMemoryHealthCache();
    cache.recordHealth("node-1", [makeReport("key-a"), makeReport("key-b")]);

    cache.clearNode("node-1");

    expect(cache.getHealth("node-1", "key-a")).toBeNull();
    expect(cache.getHealth("node-1", "key-b")).toBeNull();
  });

  test("clearNode does not affect other nodes", () => {
    const cache = new InMemoryHealthCache();
    cache.recordHealth("node-1", [makeReport("key-a")]);
    cache.recordHealth("node-2", [makeReport("key-b")]);

    cache.clearNode("node-1");

    // node-2's data must survive
    expect(cache.getHealth("node-2", "key-b")).not.toBeNull();
  });

  test("clearNode is a no-op for a node with no cached data", () => {
    const cache = new InMemoryHealthCache();
    expect(() => cache.clearNode("phantom-node")).not.toThrow();
  });

  test("re-recording the same stationKey overwrites with the new report + timestamp", () => {
    const cache = new InMemoryHealthCache();
    cache.recordHealth("node-1", [makeReport("key-a", { ok: true, running: true })], 1000);
    cache.recordHealth("node-1", [makeReport("key-a", { ok: false, running: false })], 2000);

    const got = cache.getHealth("node-1", "key-a");
    expect(got!.report.ok).toBe(false);
    expect(got!.report.running).toBe(false);
    expect(got!.at).toBe(2000);
  });

  test("multiple stations in one recordHealth call are all stored", () => {
    const cache = new InMemoryHealthCache();
    const now = 5000;
    cache.recordHealth(
      "node-1",
      [makeReport("hermes-1"), makeReport("openclaw-1"), makeReport("hermes-2")],
      now
    );

    expect(cache.getHealth("node-1", "hermes-1")).not.toBeNull();
    expect(cache.getHealth("node-1", "openclaw-1")).not.toBeNull();
    expect(cache.getHealth("node-1", "hermes-2")).not.toBeNull();
    expect(cache.getHealth("node-1", "missing")).toBeNull();
  });

  test("two different nodes with same stationKey are independent", () => {
    const cache = new InMemoryHealthCache();
    cache.recordHealth("node-a", [makeReport("shared-key", { ok: true })], 1000);
    cache.recordHealth("node-b", [makeReport("shared-key", { ok: false })], 2000);

    expect(cache.getHealth("node-a", "shared-key")!.report.ok).toBe(true);
    expect(cache.getHealth("node-b", "shared-key")!.report.ok).toBe(false);
  });
});
