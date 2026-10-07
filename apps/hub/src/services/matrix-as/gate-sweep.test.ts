/**
 * The floor beneath push.
 *
 * `charter → decisions/2026-08-30-a-gate-closes-over-chat.md` §5: "Delivery is
 * push, made durable, with a reconciliation sweep beneath it." superpipeline retries
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

import { describe, expect, spyOn, test } from "bun:test";

import { bridgeGateSweepDeps, startGateSweeper, sweepBoardNow, sweepGates, type GateSweepDeps } from "./gate-sweep";
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
  test("reports each board's pending list — the fleet card's answer to a gate settled on the board", async () => {
    const seen: Array<[string, string[]]> = [];
    const f = fake({
      boards: async () => ["brd_one", "brd_two", "brd_down"],
      pendingGates: async (boardId) => {
        if (boardId === "brd_down") throw new Error("503");
        return boardId === "brd_one" ? [gate("gate_1", boardId)] : [];
      },
      onBoardPending: async (boardId, gates) => {
        seen.push([boardId, gates.map((g) => g.gateId)]);
      },
    });
    await sweepGates(f.deps);
    // An unreachable board says nothing: its gates are not therefore closed.
    expect(seen).toEqual([
      ["brd_one", ["gate_1"]],
      ["brd_two", []],
    ]);
  });

  test("a failing pending-list report does not stop the sweep", async () => {
    const f = fake({
      onBoardPending: async () => {
        throw new Error("fleet down");
      },
    });
    expect((await sweepGates(f.deps)).projected).toBe(1);
  });

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

  test("does not count a gate whose room has a station but no agent in it", async () => {
    // The outcome this slice added, and the one that is now fleet-wide rather
    // than exceptional: `stations.principal_id` is nullable and nothing assigns
    // it, so a room can exist with nobody to post the gate AS. Distinct from
    // `no-room` — there is somewhere to put the question and no one to ask it —
    // and, like `no-room`, it is not a delivery. Counting it would make the
    // sweep's own logs say a person had been asked for an approval that is
    // still sitting on the board.
    const f = fake({}, { gate_1: { status: "no-agent" } });

    const result = await sweepGates(f.deps);

    expect(result.checked).toBe(1);
    expect(result.projected).toBe(0);
  });

  test("a station with no agent does not stop the gates behind it", async () => {
    // Every failure here is per-gate. One station left unoccupied must not take
    // the rest of the board's pending gates with it — that is how a sweep stops
    // being a floor and does it invisibly.
    const f = fake({ pendingGates: async (b) => [gate("gate_1", b), gate("gate_2", b)] }, {
      gate_1: { status: "no-agent" },
    });

    const result = await sweepGates(f.deps);

    expect(f.offered).toEqual(["gate_1", "gate_2"]);
    expect(result.projected).toBe(1);
  });

  test("tallies every outcome by status, so a pass that delivered nothing cannot read as a pass that delivered", async () => {
    // The whole-branch review's last finding, and this branch's own doing:
    // `projected` counted `sent` alone, so a sweep in which every single gate
    // came back `no-room` reported the identical number as one in which every
    // gate was already safely in a room. That is exactly the shape that hid
    // this branch's Critical — assignment never provisioned, so every gate
    // resolved `no-room`, and the floor beneath push had no way to say so.
    const f = fake(
      {
        pendingGates: async (b) => [
          gate("gate_sent", b),
          gate("gate_already", b),
          gate("gate_noroom", b),
          gate("gate_noagent", b),
          gate("gate_nospeaker", b),
        ],
      },
      {
        gate_already: { status: "already" },
        gate_noroom: { status: "no-room" },
        gate_noagent: { status: "no-agent" },
        gate_nospeaker: { status: "no-speaker" },
      },
    );

    const result = await sweepGates(f.deps);

    expect(result.byStatus).toEqual({
      sent: 1,
      already: 1,
      "no-room": 1,
      "no-agent": 1,
      "no-speaker": 1,
      "awaiting-join": 0,
      failed: 0,
    });
    // Every gate it looked at is accounted for somewhere — nothing falls
    // through the tally unseen, which is the property that failed before.
    const tallied = Object.values(result.byStatus).reduce((a, b) => a + b, 0);
    expect(tallied).toBe(result.checked);
    expect(result.projected, "and `projected` still means delivered, not seen").toBe(1);
  });

  test("a projection that throws is counted, not just logged", async () => {
    // Fix round 2. A throw left `byStatus` untouched, so `stuck` stayed 0 and
    // the tally did not add up to `checked` — the sweep reporting a clean pass
    // in which nothing was delivered. The live way to reach it: a station
    // whose identity move left it answering as an mxid its room does not
    // contain. `stationSpeaker` is non-null there, so the outcome is never
    // `no-speaker`; the homeserver 403s and `projectGate` throws.
    const f = fake({
      pendingGates: async (b) => [gate("gate_boom", b), gate("gate_fine", b)],
      project: async (_t, d) => {
        if (d.gateId === "gate_boom") throw new Error("M_FORBIDDEN: sender's membership is not join");
        return { status: "sent", eventId: "$e", roomId: "!r" };
      },
    });

    const warnSpy = spyOn(console, "warn");
    try {
      const result = await sweepGates(f.deps);

      expect(result.byStatus.failed).toBe(1);
      // The invariant that actually catches this class: every gate the sweep
      // looked at is somewhere in the tally. Before this, a throwing gate was
      // counted nowhere and the sum silently came up short.
      const tallied = Object.values(result.byStatus).reduce((a, b) => a + b, 0);
      expect(tallied).toBe(result.checked);
      // And it reaches the one-line summary an operator alerts on, rather than
      // only the per-gate line.
      const summarised = warnSpy.mock.calls.some(
        ([line]) =>
          typeof line === "string" &&
          line.includes("pending gates the sweep could not deliver") &&
          line.includes('"failed":1'),
      );
      expect(summarised, "a failed projection is in the stuck summary").toBe(true);
      // Per-gate, one gate failing does not take the rest of the pass with it.
      expect(result.byStatus.sent).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a gate it could not place reaches the log of a running hub — no-room, no-agent and no-speaker alike", async () => {
    // Behaviour, not the wording: the assertion is that each stuck outcome is
    // surfaced at warn level and identifies the gate, because the whole point
    // is that an operator sees this while it is happening rather than a
    // reviewer finding it months later.
    for (const status of ["no-room", "no-agent", "no-speaker"] as const) {
      const f = fake({}, { gate_1: { status } });
      const warnSpy = spyOn(console, "warn");
      try {
        const result = await sweepGates(f.deps);

        expect(result.byStatus[status], `${status} is counted`).toBe(1);
        const surfaced = warnSpy.mock.calls.some(([line]) =>
          typeof line === "string" && line.includes("gate_1") && line.includes(status),
        );
        expect(surfaced, `${status} is surfaced at warn, naming the gate`).toBe(true);
      } finally {
        warnSpy.mockRestore();
      }
    }
  });

  test("a pass where everything landed says nothing alarming — `already` is a delivery, not a fault", async () => {
    // The other half, and why `already` is deliberately not warned on: it is
    // the ordinary healthy answer on a sweep pass (push got there first). A
    // warn per delivered gate every five minutes would bury the three that
    // actually mean a person is waiting.
    const f = fake({ pendingGates: async (b) => [gate("gate_1", b), gate("gate_2", b)] }, {
      gate_1: { status: "already" },
      gate_2: { status: "already" },
    });

    const warnSpy = spyOn(console, "warn");
    try {
      const result = await sweepGates(f.deps);

      expect(result.byStatus.already).toBe(2);
      const alarmed = warnSpy.mock.calls.some(([line]) =>
        typeof line === "string" && line.includes("could not"),
      );
      expect(alarmed, "nothing is reported as stuck").toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
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
    source: "superpipeline",
  } as unknown as Parameters<typeof bridgeGateSweepDeps>[0];

  /**
   * The roster, as the sweep reads it now: from `bridge_agents`, per sweep, rather than from a
   * config object built once at start. Two agents on one board is ordinary — an agent is not a
   * board — and the first listed for a board is the credential used.
   */
  const ROSTER = [
    { boardId: "brd_one", token: `spa_${"a".repeat(48)}` },
    { boardId: "brd_two", token: `spa_${"b".repeat(48)}` },
    { boardId: "brd_one", token: `spa_${"c".repeat(48)}` },
  ];
  const roster = async () => ROSTER;

  function recordingFetch() {
    const sent: Array<{ url: string; token: string }> = [];
    const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string> }) => {
      sent.push({ url, token: init.headers.Authorization ?? "" });
      return { status: 200, ok: true, json: async () => ({ gates: [] }) };
    };
    return { sent, fetchImpl };
  }

  test("asks each board once, however many agents work it", async () => {
    const deps = bridgeGateSweepDeps(
      config,
      { tenantIdFor: async () => "flt_a", project: async () => ({ status: "already" }) },
      recordingFetch().fetchImpl,
      roster,
    );

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
      roster,
    );

    await deps.pendingGates("brd_two");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://board.test/v1/boards/brd_two/gates/pending");
    expect(sent[0]!.token).toBe(`Bearer ${ROSTER[1]!.token}`);
  });

  test("a board added to the roster is swept without a restart", async () => {
    // The reason the roster is read per sweep rather than once: it is a table an operator edits
    // from the console now, and a board added at noon used to go unswept until the next reboot.
    let live = [{ boardId: "brd_one", token: `spa_${"a".repeat(48)}` }];
    const deps = bridgeGateSweepDeps(
      config,
      { tenantIdFor: async () => "flt_a", project: async () => ({ status: "already" }) },
      recordingFetch().fetchImpl,
      async () => live,
    );

    expect(await deps.boards()).toEqual(["brd_one"]);
    live = [...live, { boardId: "brd_three", token: `spa_${"d".repeat(48)}` }];
    expect(await deps.boards()).toEqual(["brd_one", "brd_three"]);
  });
});

describe("starting the sweeper", () => {
  const config = {
    baseUrl: "https://board.test",
    source: "superpipeline",
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
      { config, intervalMs: 5, roster: async () => [{ boardId: "brd_one", token: `spa_${"a".repeat(48)}` }] },
    );

    expect(stop).not.toBeNull();
    await first;
    stop!();

    expect(passes).toBeGreaterThan(0);
  });
});

/**
 * A gate held until its board room has a human in it (2026-10-07) is not stuck — it is
 * waiting on a person — and it is re-offered the moment they join rather than at the
 * next five-minute pass.
 */
describe("a gate held until somebody joins its board room", () => {
  test("is tallied as awaiting-join, not as stuck and not as delivered", async () => {
    const f = fake({}, { gate_1: { status: "awaiting-join", roomId: "!board:h" } });
    const result = await sweepGates(f.deps);
    expect(result.byStatus["awaiting-join"]).toBe(1);
    expect(result.projected).toBe(0);
    expect(result.byStatus.failed).toBe(0);
  });

  test("a join sweeps that one board at once, with the running sweeper's own deps", async () => {
    const config = { baseUrl: "https://board.test", source: "superpipeline" } as unknown as Parameters<
      typeof bridgeGateSweepDeps
    >[0];
    const offeredFor: string[] = [];
    const stop = startGateSweeper(
      {
        tenantIdFor: async (boardId) => {
          offeredFor.push(boardId);
          return null;
        },
        project: async () => ({ status: "already" }),
      },
      {
        config,
        intervalMs: 60_000,
        roster: async () => [
          { boardId: "brd_one", token: `spa_${"a".repeat(48)}` },
          { boardId: "brd_two", token: `spa_${"b".repeat(48)}` },
        ],
      },
    );
    try {
      expect(await sweepBoardNow("brd_two")).not.toBeNull();
      expect(offeredFor).toEqual(["brd_two"]);
      // A board this hub does not work is not swept at all.
      offeredFor.length = 0;
      await sweepBoardNow("brd_elsewhere");
      expect(offeredFor).toEqual([]);
    } finally {
      stop!();
    }
  });

  test("with no sweeper running there is nothing to wake", async () => {
    expect(await sweepBoardNow("brd_one")).toBeNull();
  });
});

describe("settling a gate decided somewhere the room never heard about", () => {
  /**
   * A gate resolved in superpipeline's web UI leaves a live-looking card in Matrix forever.
   *
   * The receipt that settles a room card is posted by `handleGateDecision`, which runs only when a
   * decision arrives AS A MATRIX EVENT — from supermessage. A decision made on the board is
   * resolved by superpipeline directly; the hub never sees it, `markOutcomePosted` never fires,
   * and the card goes on offering Approve, Request changes and Reject for a decision already made.
   *
   * Observed live: `gate_ff389c32e0fc4ce6` approved on the web at 12:20, still live in the room
   * twenty-five minutes later beside the NEXT gate for the same card — two near-identical cards,
   * one of them a ghost, distinguishable only by a stage key in small grey text.
   *
   * The sweep already asks each board which gates are still pending. A gate this hub posted, whose
   * outcome it has not posted, and which the board no longer calls pending, was decided elsewhere.
   * That is the whole rule.
   */
  /** The full shape, because `isGatePending` filters anything else out of the pending set. */
  const pending = (gateId: string, cardId = "card_1") =>
    ({
      event: "gate.pending",
      boardId: "brd_one",
      gateId,
      cardId,
      stageKey: "angle",
      returnStageKey: "brief",
      cardTitle: "T",
      producedBy: "agt_x",
      options: [{ id: "approve", label: "Approve" }],
      ts: "2026-09-29T00:00:00.000Z",
    }) as never;

  function rig(over: Partial<Parameters<typeof sweepGates>[0]> = {}) {
    const settled: Array<{ gateId: string; decision: string }> = [];
    const deps = {
      boards: async () => ["brd_one"],
      tenantIdFor: async () => "fleet_a",
      pendingGates: async () => [] as never[],
      project: async () => ({ status: "already" }) as never,
      // what this branch adds
      postedGatesAwaitingOutcome: async () => [] as Array<{ gateId: string; cardId: string }>,
      decisionFor: async () => null as null | { decision: string; decidedBy: string | null },
      settleOutcome: async (gateId: string, decision: string) => {
        settled.push({ gateId, decision });
        return true;
      },
      ...over,
    };
    return { deps: deps as Parameters<typeof sweepGates>[0], settled };
  }

  test("posts the outcome for a gate the board no longer calls pending", async () => {
    const r = rig({
      pendingGates: async () => [pending("gate_live")] as never,
      postedGatesAwaitingOutcome: async () => [
        { gateId: "gate_live", cardId: "card_1" },
        { gateId: "gate_decided_on_the_web", cardId: "card_1" },
      ],
      decisionFor: async () => ({ decision: "approve", decidedBy: "usr_1" }),
    });

    const out = await sweepGates(r.deps);

    expect(r.settled).toEqual([{ gateId: "gate_decided_on_the_web", decision: "approve" }]);
    expect(out.settled).toBe(1);
  });

  test("leaves a gate that is still pending alone", async () => {
    const r = rig({
      pendingGates: async () => [pending("gate_live")] as never,
      postedGatesAwaitingOutcome: async () => [{ gateId: "gate_live", cardId: "card_1" }],
      decisionFor: async () => ({ decision: "approve", decidedBy: "usr_1" }),
    });

    await sweepGates(r.deps);
    expect(r.settled).toEqual([]);
  });

  test("does not settle a gate whose decision cannot be read — absence is not a decision", async () => {
    // A board that answered `pendingGates` but cannot say what the decision was leaves the card
    // alone. Posting "resolved" without knowing the outcome would be inventing one.
    const r = rig({
      postedGatesAwaitingOutcome: async () => [{ gateId: "gate_gone", cardId: "card_1" }],
      decisionFor: async () => null,
    });

    await sweepGates(r.deps);
    expect(r.settled).toEqual([]);
  });

  test("a board that could not be asked settles nothing on it", async () => {
    // `pendingGates` threw, so "not in the pending set" means "we do not know", not "decided".
    const r = rig({
      pendingGates: async () => { throw new Error("unreachable"); },
      postedGatesAwaitingOutcome: async () => [{ gateId: "gate_x", cardId: "card_1" }],
      decisionFor: async () => ({ decision: "reject", decidedBy: "usr_1" }),
    });

    const out = await sweepGates(r.deps);
    expect(r.settled).toEqual([]);
    expect(out.failedBoards).toEqual(["brd_one"]);
  });

  test("one that fails to settle does not stop the next", async () => {
    const seen: string[] = [];
    const r = rig({
      postedGatesAwaitingOutcome: async () => [
        { gateId: "gate_a", cardId: "card_1" },
        { gateId: "gate_b", cardId: "card_1" },
      ],
      decisionFor: async () => ({ decision: "approve", decidedBy: "usr_1" }),
      settleOutcome: async (gateId: string) => {
        seen.push(gateId);
        if (gateId === "gate_a") throw new Error("matrix refused");
        return true;
      },
    });

    const out = await sweepGates(r.deps);
    expect(seen).toEqual(["gate_a", "gate_b"]);
    expect(out.settled).toBe(1);
  });
});
