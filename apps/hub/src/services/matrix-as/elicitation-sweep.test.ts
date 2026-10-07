import { describe, expect, test } from "bun:test";

import type { ElicitationPendingDelivery } from "./elicitation-card";
import {
  bridgeElicitationSweepDeps,
  startElicitationSweeper,
  sweepElicitationBoardNow,
  sweepElicitations,
  type ElicitationSweepDeps,
} from "./elicitation-sweep";

/**
 * The floor beneath push, both ways.
 *
 * A delivery is retried five times and then dead-lettered, at which point a card is
 * blocked on an answer nobody was told about and neither side is looking. That is the
 * half a gate sweep already has.
 *
 * The other half matters MORE here than it does for gates. A gate stops being pending
 * only by being decided; a question is also retired the moment the same agent asks the
 * next one. So a room can hold a card for a question nobody can answer any more — and a
 * stale question that still looks answerable is one that will be answered, by somebody
 * who then watches nothing happen.
 *
 * Absence from the board's pending list is the signal for both.
 */
const BOARD = "brd_6a899b0f0d054046";

function question(id: string): ElicitationPendingDelivery {
  return {
    event: "elicitation.pending",
    boardId: BOARD,
    boardName: "Client Quality",
    cardId: "crd_a9619fe",
    cardTitle: "Add OAuth login",
    elicitationId: id,
    runId: "run_12",
    stageKey: "research",
    agentId: "agt_r",
    question: "May I run the test suite?",
    options: [{ id: "run_them", label: "Run the tests" }],
    ts: "2026-10-02T12:00:00.000Z",
  };
}

function rig(over: Partial<ElicitationSweepDeps> = {}) {
  const projected: string[] = [];
  const settled: string[] = [];
  const deps: ElicitationSweepDeps = {
    boards: async () => [BOARD],
    tenantIdFor: async () => "fleet_1",
    pendingElicitations: async () => [],
    project: async (_tenantId, d) => {
      projected.push(d.elicitationId);
      return { status: "posted", roomId: "!r:x", eventId: "$e" };
    },
    postedAwaitingOutcome: async () => [],
    settle: async (elicitationId) => {
      settled.push(elicitationId);
      return true;
    },
    ...over,
  };
  return { deps, projected, settled };
}

describe("what push lost", () => {
  test("projects a question the board is waiting on", async () => {
    const { deps, projected } = rig({ pendingElicitations: async () => [question("elc_1")] });

    const result = await sweepElicitations(deps);

    expect(projected).toEqual(["elc_1"]);
    expect(result.projected).toBe(1);
  });

  test("an already-projected question is not a problem", async () => {
    // `already` is the ordinary healthy answer on a sweep pass — somebody else got
    // there first — and counting it as a delivery would make every pass look busy.
    const { deps } = rig({
      pendingElicitations: async () => [question("elc_1")],
      project: async () => ({ status: "already" }),
    });

    const result = await sweepElicitations(deps);

    expect(result.projected).toBe(0);
    expect(result.stuck).toBe(0);
  });

  test("counts a question that could not be put anywhere as stuck", async () => {
    // A person is waiting on a question that is in no room, and nothing else is
    // looking. Silence here is how that stays invisible.
    const { deps } = rig({
      pendingElicitations: async () => [question("elc_1")],
      project: async () => ({ status: "no-room" }),
    });

    expect((await sweepElicitations(deps)).stuck).toBe(1);
  });

  test("a throw is counted, not swallowed", async () => {
    const { deps } = rig({
      pendingElicitations: async () => [question("elc_1")],
      project: async () => {
        throw new Error("homeserver said no");
      },
    });

    const result = await sweepElicitations(deps);

    expect(result.stuck).toBe(1);
    expect(result.projected).toBe(0);
  });

  test("a board that cannot be read does not stop the others", async () => {
    // One unreachable board must not cost every other board its sweep.
    const { deps, projected } = rig({
      boards: async () => ["brd_bad", BOARD],
      pendingElicitations: async (boardId) => {
        if (boardId === "brd_bad") throw new Error("401");
        return [question("elc_1")];
      },
    });

    const result = await sweepElicitations(deps);

    expect(projected).toEqual(["elc_1"]);
    expect(result.boardsUnread).toBe(1);
  });

  test("a board this hub never worked is skipped without reading it", async () => {
    // No tenant means no card on it was ever dispatched to a station, so no question
    // on it can have a room. Reading it would be a request for nothing.
    let read = false;
    const { deps } = rig({
      tenantIdFor: async () => null,
      pendingElicitations: async () => {
        read = true;
        return [];
      },
    });

    await sweepElicitations(deps);

    expect(read).toBe(false);
  });
});

describe("what is over", () => {
  test("settles a question the board is no longer waiting on", async () => {
    // Answered on the board, or retired by a newer question from the same agent.
    const { deps, settled } = rig({
      pendingElicitations: async () => [],
      postedAwaitingOutcome: async () => [{ elicitationId: "elc_old", roomId: "!r:x" }],
    });

    const result = await sweepElicitations(deps);

    expect(settled).toEqual(["elc_old"]);
    expect(result.settled).toBe(1);
  });

  test("leaves a question the board is still waiting on alone", async () => {
    // The test that stops the sweep settling every open question on every pass.
    const { deps, settled } = rig({
      pendingElicitations: async () => [question("elc_live")],
      postedAwaitingOutcome: async () => [{ elicitationId: "elc_live", roomId: "!r:x" }],
    });

    const result = await sweepElicitations(deps);

    expect(settled).toEqual([]);
    expect(result.settled).toBe(0);
  });

  test("does not settle anything for a board it could not read", async () => {
    // A board that did not answer is not a board with no pending questions. Treating
    // silence as "everything is over" would close every open question on a timeout.
    const { deps, settled } = rig({
      pendingElicitations: async () => {
        throw new Error("502");
      },
      postedAwaitingOutcome: async () => [{ elicitationId: "elc_live", roomId: "!r:x" }],
    });

    await sweepElicitations(deps);

    expect(settled).toEqual([]);
  });

  test("a settle that somebody else already claimed is not counted twice", async () => {
    const { deps } = rig({
      postedAwaitingOutcome: async () => [{ elicitationId: "elc_old", roomId: "!r:x" }],
      settle: async () => false,
    });

    expect((await sweepElicitations(deps)).settled).toBe(0);
  });
});

/**
 * A question held until a human has joined its board room (2026-10-07) is waiting on a
 * person, not stuck; it is not a delivery either. A join re-offers it at once.
 */
describe("a question held until somebody joins its board room", () => {
  test("is neither projected nor stuck", async () => {
    const { deps } = rig({
      pendingElicitations: async () => [question("eli_held")],
      project: async () => ({ status: "awaiting-join", roomId: "!board:x" }),
    });
    const result = await sweepElicitations(deps);
    expect(result.projected).toBe(0);
    expect(result.stuck).toBe(0);
    expect(result.awaitingJoin).toBe(1);
  });

  test("is never settled while held — it has no room card to close", async () => {
    const { deps, settled } = rig({
      pendingElicitations: async () => [question("eli_held")],
      project: async () => ({ status: "awaiting-join", roomId: "!board:x" }),
      postedAwaitingOutcome: async () => [],
    });
    await sweepElicitations(deps);
    expect(settled).toEqual([]);
  });

  test("a join sweeps that one board at once, with the running sweeper's own deps", async () => {
    const config = { baseUrl: "https://board.test", source: "superpipeline" } as unknown as Parameters<
      typeof bridgeElicitationSweepDeps
    >[0];
    const asked: string[] = [];
    const stop = startElicitationSweeper(
      {
        tenantIdFor: async (boardId) => {
          asked.push(boardId);
          return null;
        },
        project: async () => ({ status: "already" }),
        postedAwaitingOutcome: async () => [],
        settle: async () => false,
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
      expect(await sweepElicitationBoardNow("brd_two")).not.toBeNull();
      expect(asked).toEqual(["brd_two"]);
      asked.length = 0;
      await sweepElicitationBoardNow("brd_elsewhere");
      expect(asked).toEqual([]);
    } finally {
      stop!();
    }
  });

  test("with no sweeper running there is nothing to wake", async () => {
    expect(await sweepElicitationBoardNow("brd_one")).toBeNull();
  });
});
