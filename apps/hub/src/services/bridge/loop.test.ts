/**
 * The loop's control flow, and the gate in front of it.
 *
 * The behaviour under test is the difference a 403 and a 409 make to what
 * happens NEXT: a lost lease is ordinary and the agent claims again; a run that
 * belonged to another agent halts the loop, because claiming again walks
 * straight back into the same bug.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { BRIDGE_ENV_FLAG } from "./config";
import type { DispatchResult } from "./dispatch";
import { KaambaanApiError } from "./kaambaan";
import { startAgentLoop, startKaambaanBridge } from "./loop";

const saved = process.env[BRIDGE_ENV_FLAG];
afterEach(() => {
  if (saved === undefined) delete process.env[BRIDGE_ENV_FLAG];
  else process.env[BRIDGE_ENV_FLAG] = saved;
});

/** A run function that returns a scripted sequence, then idles forever. */
function scripted(...results: DispatchResult[]) {
  const calls: DispatchResult[] = [];
  return {
    calls,
    run: async (): Promise<DispatchResult> => {
      const next = results[calls.length] ?? ({ status: "idle" } as DispatchResult);
      calls.push(next);
      return next;
    },
  };
}

/** No real waiting: a poll resolves immediately unless the loop has stopped. */
const noSleep = async (_ms: number, signal: AbortSignal) => {
  if (signal.aborted) return;
};

describe("the loop keeps claiming", () => {
  test("a lost lease is ordinary — the agent claims again", async () => {
    const s = scripted(
      { status: "lease-superseded", externalRunId: "run_1" },
      { status: "reported", externalRunId: "run_2" },
    );
    const loop = startAgentLoop({ run: s.run, sleep: noSleep });
    while (s.calls.length < 3) await Promise.resolve();
    await loop.stop();

    expect(s.calls[0]!.status).toBe("lease-superseded");
    expect(s.calls[1]!.status).toBe("reported");
    expect(s.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("a throw backs off instead of spinning", async () => {
    let calls = 0;
    const run = async (): Promise<DispatchResult> => {
      calls++;
      throw new Error("board unreachable");
    };
    let sleptFor = 0;
    const loop = startAgentLoop({
      run,
      backoffMs: 30_000,
      sleep: async (ms) => {
        sleptFor = ms;
      },
    });
    while (calls < 2) await Promise.resolve();
    await loop.stop();
    expect(sleptFor).toBe(30_000);
  });

  test("stop ends the loop", async () => {
    const s = scripted();
    const loop = startAgentLoop({ run: s.run, sleep: noSleep });
    await loop.stop();
    const seen = s.calls.length;
    await Promise.resolve();
    expect(s.calls.length).toBe(seen);
  });
});

describe("a run that belonged to another agent halts the loop", () => {
  test("nothing is claimed after it", async () => {
    const s = scripted({ status: "foreign-run", externalRunId: "run_1" });
    const faults: DispatchResult[] = [];
    const loop = startAgentLoop({ run: s.run, sleep: noSleep, onFault: (r) => faults.push(r) });

    await loop.done;
    expect(s.calls).toHaveLength(1);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.externalRunId).toBe("run_1");
  });

  test("a lost lease does NOT halt it — the two are not the same fact", async () => {
    const s = scripted({ status: "lease-superseded", externalRunId: "run_1" });
    const faults: DispatchResult[] = [];
    const loop = startAgentLoop({ run: s.run, sleep: noSleep, onFault: (r) => faults.push(r) });

    while (s.calls.length < 2) await Promise.resolve();
    await loop.stop();
    expect(faults).toHaveLength(0);
  });
});

describe("a station that is down does not become a claim storm", () => {
  test("a station that is not ready backs off — it does not poll every 5s", async () => {
    const s = scripted({ status: "not-ready", reason: "Node is offline." });
    const slept: number[] = [];
    const loop = startAgentLoop({
      run: s.run,
      pollMs: 5_000,
      backoffMs: 30_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    while (s.calls.length < 2) await Promise.resolve();
    await loop.stop();

    expect(slept[0]).toBe(30_000);
    expect(slept[0]).not.toBe(5_000);
  });

  test("a claim handed straight back backs off too — claim/release/claim is not a fix", async () => {
    // The card is back on the board the moment we release it, so an immediate
    // re-claim would take it again, fail again and churn the board.
    const s = scripted(
      { status: "released", externalRunId: "run_1" },
      { status: "released", externalRunId: "run_2" },
    );
    const slept: number[] = [];
    const loop = startAgentLoop({
      run: s.run,
      pollMs: 5_000,
      backoffMs: 30_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    while (s.calls.length < 2) await Promise.resolve();
    await loop.stop();

    expect(slept.slice(0, 2)).toEqual([30_000, 30_000]);
  });

  test("a reported run claims again immediately — the backoff is for faults only", async () => {
    const s = scripted({ status: "reported", externalRunId: "run_1" });
    const slept: number[] = [];
    const loop = startAgentLoop({
      run: s.run,
      pollMs: 5_000,
      backoffMs: 30_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    while (s.calls.length < 2) await Promise.resolve();
    await loop.stop();

    // Nothing after the reported cycle; the next cycle idles and polls.
    expect(slept).not.toContain(30_000);
  });
});

describe("off by default", () => {
  test("an unconfigured hub starts no bridge and touches nothing", async () => {
    delete process.env[BRIDGE_ENV_FLAG];
    let touched = false;
    const acp = new Proxy({} as never, {
      get() {
        touched = true;
        throw new Error("the bridge touched ACP while disabled");
      },
    });

    expect(await startKaambaanBridge({ acp })).toBeNull();
    expect(touched).toBe(false);
  });
});

describe("a credential kaambaan will not accept", () => {
  /**
   * Found on the live fleet, 2026-09-04: the hub had been claiming against a board with a
   * token whose agent was deleted three days earlier. Every thirty seconds, a 401, logged and
   * retried — 8,640 identical lines a day, and no signal beyond noise nobody reads.
   *
   * A 401 does not improve by being asked again. It halts on the same terms as `foreign-run`:
   * stop, say why once, make somebody look.
   */
  test("halts instead of retrying forever", async () => {
    let calls = 0;
    const lines: string[] = [];
    const handle = startAgentLoop({
      run: async () => {
        calls++;
        throw new KaambaanApiError(401, "/v1/boards/brd_x/claims", null, "a valid agent token is required");
      },
      log: (m) => lines.push(m),
      sleep: async () => {},
    });
    await handle.done;

    expect(calls).toBe(1); // not two, not forever
    expect(lines.some((l) => l.includes("refused this agent's credential"))).toBe(true);
  });

  test("halts on a 403 too — a refusal is not a transient error", async () => {
    let calls = 0;
    const handle = startAgentLoop({
      run: async () => {
        calls++;
        throw new KaambaanApiError(403, "/v1/boards/brd_x/claims", null, "forbidden");
      },
      log: () => {},
      sleep: async () => {},
    });
    await handle.done;
    expect(calls).toBe(1);
  });

  test("a 500 still backs off and retries, because that one can come right", async () => {
    let calls = 0;
    const handle = startAgentLoop({
      run: async () => {
        calls++;
        if (calls >= 3) handle.stop();
        throw new KaambaanApiError(500, "/v1/boards/brd_x/claims", null, "upstream exploded");
      },
      log: () => {},
      sleep: async () => {},
    });
    await handle.done;
    expect(calls).toBeGreaterThan(1);
  });
});

describe("a cycle that never comes back", () => {
  /**
   * Observed on the live fleet, 2026-09-08. The bridge logged one cycle at 05:52:30 and then
   * nothing at all — not an error, not an idle poll, nothing — while the process stayed healthy
   * and its connection to Cloudflare stayed ESTABLISHED with both queues empty. A call had been
   * sent and never answered, and `fetchAdapter` had no timeout, so the agent was gone.
   *
   * A hang is the worst of the three failure shapes: an error logs, a refusal halts, but a hang
   * is indistinguishable from an idle fleet.
   */
  test("does not block the loop forever", async () => {
    let calls = 0;
    const handle = startAgentLoop({
      run: () => {
        calls++;
        if (calls >= 3) {
          handle.stop();
          return Promise.resolve({ status: "idle" } as DispatchResult);
        }
        return new Promise<DispatchResult>(() => {}); // never settles
      },
      log: () => {},
      sleep: async () => {},
      cycleTimeoutMs: 20,
    });
    await handle.done;
    expect(calls).toBeGreaterThan(1); // it got past the hang
  });

  test("says so, rather than failing silently", async () => {
    const lines: string[] = [];
    const handle = startAgentLoop({
      run: () => new Promise<DispatchResult>(() => {}),
      log: (m) => {
        lines.push(m);
        if (lines.length >= 2) handle.stop();
      },
      sleep: async () => {},
      cycleTimeoutMs: 10,
    });
    await handle.done;
    expect(lines.some((l) => l.includes("exceeded its deadline"))).toBe(true);
  });

  test("a cycle that finishes in time is untouched by the deadline", async () => {
    let calls = 0;
    const handle = startAgentLoop({
      run: async (): Promise<DispatchResult> => {
        calls++;
        if (calls >= 2) handle.stop();
        return { status: "idle" } as DispatchResult;
      },
      log: () => {},
      sleep: async () => {},
      cycleTimeoutMs: 5_000,
    });
    await handle.done;
    expect(calls).toBe(2);
  });
});
