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
