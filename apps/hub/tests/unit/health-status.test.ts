/**
 * Unit Tests: deriveStatus (control-plane P2)
 *
 * Covers the pure status derivation helper exported from fleet.ts.
 * No database, network, or WS connections required.
 *
 * Status rule (in priority order):
 *   1. node offline              → "unknown" + null metrics
 *   2. no cached report          → "unknown" + null metrics
 *   3. age > 75 000 ms           → "unknown" + null metrics (stale)
 *   4. report.ok === false       → "error"   + null metrics
 *   5. ok=true && running=true   → "running" + metrics from report
 *   6. ok=true && running=false  → "stopped" + metrics from report
 */

import { test, expect, describe } from "bun:test";
import { deriveStatus } from "../../src/services/nodes/fleet";
import type { StationHealthReport } from "@agentpod/contract";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const STALE_MS = 75_000;
const NOW = 1_000_000_000; // arbitrary fixed "now"

function makeReport(
  ok: boolean,
  running: boolean,
  overrides: Partial<StationHealthReport> = {}
): StationHealthReport {
  return {
    key: "test-station",
    ok,
    running,
    pid: running ? 4242 : null,
    cpuPct: running ? 12.5 : null,
    memBytes: running ? 256 * 1024 * 1024 : null,
    uptimeSec: running ? 7200 : null,
    ...overrides,
  };
}

function makeCached(
  report: StationHealthReport,
  age: number = 1_000
): { report: StationHealthReport; at: number } {
  return { report, at: NOW - age };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("deriveStatus — node offline", () => {
  test("returns unknown + null metrics regardless of cache", () => {
    const cached = makeCached(makeReport(true, true));
    const result = deriveStatus("offline", cached, NOW);
    expect(result.status).toBe("unknown");
    expect(result.cpuPct).toBeNull();
    expect(result.memBytes).toBeNull();
    expect(result.uptimeSec).toBeNull();
  });

  test("returns unknown when offline with no cache entry", () => {
    const result = deriveStatus("offline", null, NOW);
    expect(result.status).toBe("unknown");
  });
});

describe("deriveStatus — no cached report", () => {
  test("returns unknown + null metrics when cached is null", () => {
    const result = deriveStatus("online", null, NOW);
    expect(result.status).toBe("unknown");
    expect(result.cpuPct).toBeNull();
    expect(result.memBytes).toBeNull();
    expect(result.uptimeSec).toBeNull();
  });
});

describe("deriveStatus — stale report", () => {
  test("age exactly = STALE_MS is NOT stale (boundary: > not >=)", () => {
    // age === 75 000 ms: NOT stale → should resolve to "running"
    const cached = makeCached(makeReport(true, true), STALE_MS);
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("running");
  });

  test("age STALE_MS + 1 ms IS stale → unknown", () => {
    const cached = makeCached(makeReport(true, true), STALE_MS + 1);
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("unknown");
    expect(result.cpuPct).toBeNull();
  });

  test("very old report (>5 min) → unknown", () => {
    const cached = makeCached(makeReport(true, true), 10 * 60 * 1000);
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("unknown");
  });
});

describe("deriveStatus — error", () => {
  test("ok=false → error + null metrics", () => {
    const cached = makeCached(makeReport(false, false));
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("error");
    expect(result.cpuPct).toBeNull();
    expect(result.memBytes).toBeNull();
    expect(result.uptimeSec).toBeNull();
  });

  test("ok=false even with running=true → error (ok wins over running)", () => {
    const cached = makeCached(makeReport(false, true));
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("error");
  });
});

describe("deriveStatus — running", () => {
  test("ok=true, running=true → status running with populated metrics", () => {
    const cached = makeCached(makeReport(true, true));
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("running");
    expect(result.cpuPct).toBe(12.5);
    expect(result.memBytes).toBe(256 * 1024 * 1024);
    expect(result.uptimeSec).toBe(7200);
  });

  test("metrics are null from the report when process has null metrics", () => {
    const report = makeReport(true, true, {
      cpuPct: null,
      memBytes: null,
      uptimeSec: null,
    });
    const cached = makeCached(report);
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("running");
    expect(result.cpuPct).toBeNull();
  });
});

describe("deriveStatus — stopped", () => {
  test("ok=true, running=false → stopped", () => {
    const cached = makeCached(makeReport(true, false));
    const result = deriveStatus("online", cached, NOW);
    expect(result.status).toBe("stopped");
    // pid/cpu/mem/uptime may be null for a stopped process — the report controls these
  });
});
