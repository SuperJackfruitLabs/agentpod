/**
 * Unit Tests: agent-version service (self-update slice 3)
 *
 * Verifies:
 *   1. Successful fetch → returns tag_name.
 *   2. Second call within TTL → fetch NOT called a second time (cache hit).
 *   3. Fetch failure → returns null (no throw).
 *   4. Cache returned on second failure → stale value or null.
 *
 * No DB or network required — fetch is injected via options.
 */

import { test, expect, beforeEach } from "bun:test";
import {
  getLatestAgentVersion,
  _resetCache,
} from "../../src/services/nodes/agent-version";

// Reset the module-level cache before every test so tests are independent.
beforeEach(() => {
  _resetCache();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("returns tag_name from GitHub API on first call", async () => {
  const mockFetch = async (_url: string): Promise<Response> =>
    ({ json: async () => ({ tag_name: "v0.1.3" }) } as Response);

  const result = await getLatestAgentVersion({ fetch: mockFetch });
  expect(result).toBe("v0.1.3");
});

test("second call within TTL does not re-fetch (fetch called once)", async () => {
  let fetchCount = 0;
  const mockFetch = async (_url: string): Promise<Response> => {
    fetchCount++;
    return { json: async () => ({ tag_name: "v0.1.3" }) } as Response;
  };

  const t0 = Date.now();
  // First call — populates cache
  await getLatestAgentVersion({ fetch: mockFetch, now: () => t0 });
  // Second call — 30 seconds later (well within the 1-hour TTL)
  const result = await getLatestAgentVersion({
    fetch: mockFetch,
    now: () => t0 + 30_000,
  });

  expect(fetchCount).toBe(1); // fetch must NOT have been called a second time
  expect(result).toBe("v0.1.3");
});

test("fetch failure returns null without throwing", async () => {
  const failFetch = async (_url: string): Promise<Response> => {
    throw new Error("network error");
  };

  const result = await getLatestAgentVersion({ fetch: failFetch });
  expect(result).toBeNull();
});

test("fetch failure after a prior successful call returns the cached value", async () => {
  let shouldFail = false;
  const mockFetch = async (_url: string): Promise<Response> => {
    if (shouldFail) throw new Error("network error");
    return { json: async () => ({ tag_name: "v0.1.2" }) } as Response;
  };

  const t0 = Date.now();
  // Populate cache with "v0.1.2"
  await getLatestAgentVersion({ fetch: mockFetch, now: () => t0 });

  // Advance clock past TTL so the next call tries to re-fetch
  shouldFail = true;
  const result = await getLatestAgentVersion({
    fetch: mockFetch,
    now: () => t0 + TTL_MS_FOR_TEST + 1,
  });

  // Must return the stale cached value, not throw
  expect(result).toBe("v0.1.2");
});

// Re-export the TTL constant used in the last test (avoids magic numbers).
const TTL_MS_FOR_TEST = 3_600_000;
