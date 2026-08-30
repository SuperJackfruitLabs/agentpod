/**
 * The floor beneath push.
 *
 * `charter → decisions/2026-08-30-a-gate-closes-over-chat.md` §5: "Delivery is
 * push, made durable, with a reconciliation sweep beneath it." kaambaan retries
 * a delivery five times and then dead-letters it. At that point the gate is
 * silent on both sides — the card is blocked on an approval nobody was ever
 * told about, and neither product is looking. This asks the board directly.
 *
 * The sweep deliberately holds no idempotency of its own. `projectGate` claims
 * a gate in `matrix_gate_events` before it sends, so re-offering a gate that is
 * already in a room costs one refused insert and posts nothing. Putting a
 * second "have I sent this?" check here would be a second answer to a question
 * that already has one, and the two would eventually disagree.
 */

import { describe, expect, test } from "bun:test";

import { bridgeGateSweepDeps, startGateSweeper, sweepGates, type GateSweepDeps } from "./gate-sweep";
import type { GatePendingDelivery, ProjectionOutcome } from "./gates";

function gate(gateId: string, boardId: string): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId,
    cardId: `crd_${gateId}`,
    gateId,
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Add OAuth login",
    producedBy: "agt_31d0",
    options: [{ id: "approve", label: "Approve" }],
    ts: "2026-08-30T00:00:00.000Z",
  };
}

interface Fake {
  deps: GateSweepDeps;
  offered: string[];
  asked: string[];
}

function fake(overrides: Partial<GateSweepDeps> = {}, outcomes: Record<string, ProjectionOutcome> = {}): Fake {
  const offered: string[] = [];
  const asked: string[] = [];
  const deps: GateSweepDeps = {
    boards: async () => ["brd_one"],
    tenantIdFor: async () => "flt_a",
    pendingGates: async (boardId) => {
      asked.push(boardId);
      return [gate("gate_1", boardId)];
    },
    project: async (_tenantId, d) => {
      offered.push(d.gateId);
      return outcomes[d.gateId] ?? { status: "sent", eventId: "$ev", roomId: "!r:h" };
    },
    ...overrides,
  };
  return { deps, offered, asked };
}

describe("the gate sweep", () => {
  test("offers every pending gate on every board this hub works", async () => {
    const f = fake({
      boards: async () => ["brd_one", "brd_two"],
      pendingGates: async (boardId) =>
        boardId === "brd_one" ? [gate("gate_1", boardId)] : [gate("gate_2", boardId), gate("gate_3", boardId)],
    });

    const result = await sweepGates(f.deps);

    expect(f.offered).toEqual(["gate_1", "gate_2", "gate_3"]);
    expect(result.projected).toBe(3);
  });

  test("counts what it posted, not what it looked at", async () => {
    // The number that matters operationally. A sweep reporting three when the
    // room got one is a sweep whose logs say it is working while gates are
    // being dropped somewhere below it.
    const f = fake({ pendingGates: async (b) => [gate("gate_1", b), gate("gate_2", b)] }, {
      gate_2: { status: "already" },
    });

    const result = await sweepGates(f.deps);

    expect(result.checked).toBe(2);
    expect(result.projected).toBe(1);
  });

  test("does not count a gate that found no room to appear in", async () => {
    // A gate on a card no AgentPod station ran. Named as a cost in the charter
    // decision: there is no room, so there is no projection. It must not read
    // as delivered.
    const f = fake({}, { gate_1: { status: "no-room" } });

    expect((await sweepGates(f.deps)).projected).toBe(0);
  });

  test("never asks a board whose gates it could not place anyway", async () => {
    // `tenantIdFor` is null for a board this hub has never dispatched work to,
    // which means no card→station binding and therefore no room for any gate on
    // it. Asking would spend a request to learn something already known.
    const f = fake({ tenantIdFor: async () => null });

    const result = await sweepGates(f.deps);

    expect(f.asked).toEqual([]);
    expect(result.checked).toBe(0);
  });

  test("keeps sweeping when one board cannot be reached", async () => {
    // The regression that would matter most: a sweep that dies on the first
    // unreachable board stops being a floor, and does it silently — the boards
    // after it are simply never asked.
    const f = fake({
      boards: async () => ["brd_down", "brd_up"],
      pendingGates: async (boardId) => {
        if (boardId === "brd_down") throw new Error("connect ECONNREFUSED");
        return [gate("gate_2", boardId)];
      },
    });

    const result = await sweepGates(f.deps);

    expect(f.offered).toEqual(["gate_2"]);
    expect(result.projected).toBe(1);
    expect(result.failedBoards).toEqual(["brd_down"]);
  });

  test("refuses to project a gate in a shape it does not understand", async () => {
    // The push receiver validates because bytes arrive over a webhook; these
    // arrive over an authenticated read, which is not the same as a checked
    // one. A board a version ahead — or behind — would otherwise have this hub
    // posting a card with an empty title and no options into someone's room.
    // Both paths refuse through the same predicate, so neither can drift alone.
    const f = fake({
      pendingGates: async (b) =>
        [{ event: "gate.pending", boardId: b, cardId: "crd_1" }, gate("gate_2", b)] as GatePendingDelivery[],
    });

    const result = await sweepGates(f.deps);

    expect(f.offered).toEqual(["gate_2"]);
    expect(result.checked).toBe(1);
  });

  test("keeps sweeping when one gate cannot be projected", async () => {
    // One room the appservice cannot post to must not cost every gate behind it
    // in the same pass.
    const f = fake({
      pendingGates: async (b) => [gate("gate_1", b), gate("gate_2", b)],
      project: async (_t, d) => {
        if (d.gateId === "gate_1") throw new Error("M_FORBIDDEN");
        return { status: "sent", eventId: "$ev", roomId: "!r:h" };
      },
    });

    expect((await sweepGates(f.deps)).projected).toBe(1);
  });
});

describe("what the sweep reads, and as whom", () => {
  const config = {
    baseUrl: "https://board.test",
    source: "kaambaan",
    agents: [
      { key: "forge", boardId: "brd_one", token: `kbn_${"a".repeat(48)}`, stationId: "stn_1", hubUserId: "usr_1" },
      { key: "quill", boardId: "brd_two", token: `kbn_${"b".repeat(48)}`, stationId: "stn_2", hubUserId: "usr_1" },
      // Two agents on one board is ordinary: an agent is not a board.
      { key: "scout", boardId: "brd_one", token: `kbn_${"c".repeat(48)}`, stationId: "stn_3", hubUserId: "usr_1" },
    ],
  } as unknown as Parameters<typeof bridgeGateSweepDeps>[0];

  function recordingFetch() {
    const sent: Array<{ url: string; token: string }> = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      sent.push({ url, token: init.headers.Authorization ?? "" });
      return { status: 200, ok: true, json: async () => ({ gates: [] }) };
    };
    return { sent, fetchImpl };
  }

  test("asks each board once, however many agents work it", async () => {
    const deps = bridgeGateSweepDeps(config, { tenantIdFor: async () => "flt_a", project: async () => ({ status: "already" }) });

    // Two agents claim on brd_one. Sweeping it twice would ask the same
    // question twice and log every recovered gate twice with it.
    expect(await deps.boards()).toEqual(["brd_one", "brd_two"]);
  });

  test("reads a board with the credential belonging to that board", async () => {
    // The failure this prevents is quiet: an agent's token is scoped to its own
    // board, so sweeping brd_two with brd_one's token is a 401 that reads, in
    // the sweep's own result, as a board that could not be reached.
    const { sent, fetchImpl } = recordingFetch();
    const deps = bridgeGateSweepDeps(
      config,
      { tenantIdFor: async () => "flt_a", project: async () => ({ status: "already" }) },
      fetchImpl,
    );

    await deps.pendingGates("brd_two");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://board.test/v1/boards/brd_two/gates/pending");
    expect(sent[0]!.token).toBe(`Bearer ${config.agents[1]!.token}`);
  });
});

describe("starting the sweeper", () => {
  const config = {
    baseUrl: "https://board.test",
    source: "kaambaan",
    agents: [{ key: "forge", boardId: "brd_one", token: `kbn_${"a".repeat(48)}`, stationId: "s", hubUserId: "u" }],
  } as unknown as Parameters<typeof bridgeGateSweepDeps>[0];

  test("does not start on a hub that works no board", async () => {
    // Most hubs. A timer here would wake every five minutes to iterate an empty
    // list, and any error inside it would be reported by a subsystem the
    // operator never turned on.
    expect(startGateSweeper({ tenantIdFor: async () => null, project: async () => ({ status: "already" }) }, { config: null })).toBeNull();
  });

  test("actually runs a pass — an unstarted sweeper is the whole bug", async () => {
    // `dispatchPushDeliveries` existed for weeks with nothing calling it, so a
    // queued gate sat until something external poked the board. The same shape
    // of mistake here would be a sweep that is written, tested, deployed, and
    // never runs.
    let passes = 0;
    let resolveFirst: () => void;
    const first = new Promise<void>((r) => (resolveFirst = r));

    const stop = startGateSweeper(
      {
        tenantIdFor: async () => {
          passes++;
          resolveFirst!();
          return null;
        },
        project: async () => ({ status: "already" }),
      },
      { config, intervalMs: 5 },
    );

    expect(stop).not.toBeNull();
    await first;
    stop!();

    expect(passes).toBeGreaterThan(0);
  });
});
