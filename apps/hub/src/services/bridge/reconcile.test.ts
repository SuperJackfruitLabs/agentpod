/**
 * The supervisor that makes a console edit take effect without a restart.
 *
 * The roster used to be read once, at boot, from an environment variable. Now it is a table, and
 * this is what turns a change in that table into a loop starting, stopping or being rebuilt —
 * the same shape as `services/node-sweeper.ts`: a tick, a desired state, and a diff.
 *
 * No database here. The reconciler takes the roster as a function, so what is under test is the
 * diffing and the lifecycle, not Postgres.
 */

import { describe, expect, test } from "bun:test";

import { reconcileRoster, type LoopRegistry, type ReconcileState } from "./reconcile";
import type { BridgeAgentSecrets } from "./roster";

const agent = (key: string, over: Partial<BridgeAgentSecrets> = {}): BridgeAgentSecrets => ({
  key,
  boardId: "brd_6a899b0f0d054046",
  stationId: `station_${key}`,
  hubUserId: "usr_1",
  mode: "full-auto",
  permissionWaitMs: null,
  maxConcurrency: null,
  profileKey: null,
  token: `spa_${key}`,
  mcpToken: null,
  revision: `rev-${key}-1`,
  updatedAt: new Date("2026-09-29T00:00:00Z"),
  ...over,
});

/** A registry that records what it was asked to do instead of starting real loops. */
function fakeRegistry() {
  const started: string[] = [];
  const stopped: string[] = [];
  const live = new Map<string, { revision: string }>();

  const registry: LoopRegistry = {
    running: () => new Map([...live].map(([k, v]) => [k, v.revision])),
    start: (a) => {
      started.push(a.key);
      live.set(a.key, { revision: a.revision });
    },
    stop: async (key) => {
      stopped.push(key);
      live.delete(key);
    },
  };

  return { registry, started, stopped, live };
}

describe("bringing the fleet of loops to match the table", () => {
  test("a key in the table with no loop is started", async () => {
    const r = fakeRegistry();
    await reconcileRoster(r.registry, [agent("coder-kai"), agent("writer-quill")]);
    expect(r.started.sort()).toEqual(["coder-kai", "writer-quill"]);
    expect(r.stopped).toEqual([]);
  });

  test("a second tick with an unchanged table starts nothing", async () => {
    // The tick runs every few seconds forever. A reconciler that restarted a loop because it
    // ran again would never let an agent finish a card.
    const r = fakeRegistry();
    await reconcileRoster(r.registry, [agent("coder-kai")]);
    await reconcileRoster(r.registry, [agent("coder-kai")]);
    expect(r.started).toEqual(["coder-kai"]);
    expect(r.stopped).toEqual([]);
  });

  test("a loop whose row vanished is stopped", async () => {
    const r = fakeRegistry();
    await reconcileRoster(r.registry, [agent("coder-kai"), agent("writer-quill")]);
    await reconcileRoster(r.registry, [agent("coder-kai")]);
    expect(r.stopped).toEqual(["writer-quill"]);
  });

  test("a disabled agent is simply absent from the roster, so its loop is stopped the same way", async () => {
    // `readBridgeRoster` filters `enabled` out, so disabling and deleting look identical here —
    // deliberately: the difference matters to a human reading the list, not to the supervisor.
    const r = fakeRegistry();
    await reconcileRoster(r.registry, [agent("coder-kai")]);
    await reconcileRoster(r.registry, []);
    expect(r.stopped).toEqual(["coder-kai"]);
  });

  test("an edited row is stopped and started again, in that order", async () => {
    const r = fakeRegistry();
    await reconcileRoster(r.registry, [agent("coder-kai")]);
    await reconcileRoster(r.registry, [agent("coder-kai", { revision: "rev-coder-kai-2", mode: "ask" })]);

    expect(r.started).toEqual(["coder-kai", "coder-kai"]);
    expect(r.stopped).toEqual(["coder-kai"]);
    // The new loop carries the new configuration, which is the entire point of restarting it.
    expect(r.live.get("coder-kai")!.revision).toBe("rev-coder-kai-2");
  });

  test("the stop is awaited before the restart — a card must not be worked by two loops", async () => {
    const order: string[] = [];
    const live = new Map<string, string>([["coder-kai", "rev-1"]]);
    const registry: LoopRegistry = {
      running: () => new Map(live),
      start: (a) => {
        order.push("start");
        live.set(a.key, a.revision);
      },
      stop: async (key) => {
        order.push("stop:begin");
        await new Promise((r) => setTimeout(r, 5));
        order.push("stop:end");
        live.delete(key);
      },
    };

    await reconcileRoster(registry, [agent("coder-kai", { revision: "rev-2" })]);
    expect(order).toEqual(["stop:begin", "stop:end", "start"]);
  });

  test("one agent's failure to start does not stop the others", async () => {
    const started: string[] = [];
    const live = new Map<string, string>();
    const registry: LoopRegistry = {
      running: () => new Map(live),
      start: (a) => {
        if (a.key === "broken") throw new Error("no such station");
        started.push(a.key);
        live.set(a.key, a.revision);
      },
      stop: async () => {},
    };

    const failures: Array<{ key: string; error: string }> = [];
    await reconcileRoster(registry, [agent("broken"), agent("coder-kai")], {
      onError: (key, error) => failures.push({ key, error }),
    });

    expect(started).toEqual(["coder-kai"]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.key).toBe("broken");
  });
});

describe("the quiet-board signal the boot-time check used to give", () => {
  test("an empty roster is reported once, not on every tick", async () => {
    // Losing this was the cost of moving the roster out of an env var: `validateConfig` cannot
    // reach the table. It comes back here — but a line every few seconds forever is the noise
    // the coalescing work exists to prevent.
    const r = fakeRegistry();
    const empties: number[] = [];
    const onEmpty = () => empties.push(1);
    const state: ReconcileState = {};

    await reconcileRoster(r.registry, [], { onEmpty, state });
    await reconcileRoster(r.registry, [], { onEmpty, state });
    await reconcileRoster(r.registry, [], { onEmpty, state });

    expect(empties).toHaveLength(1);
  });

  test("it is reported again after the roster empties a second time", async () => {
    const r = fakeRegistry();
    const empties: number[] = [];
    const onEmpty = () => empties.push(1);
    const state: ReconcileState = {};

    await reconcileRoster(r.registry, [], { onEmpty, state });
    await reconcileRoster(r.registry, [agent("coder-kai")], { onEmpty, state });
    await reconcileRoster(r.registry, [], { onEmpty, state });

    expect(empties).toHaveLength(2);
  });
});
