import { describe, expect, test } from "bun:test";
import { RunState, TERMINAL_RUN_STATES, isRunTerminal, Run, Change } from "./run";
import { AcpRunId, KaambaanRunId } from "./ids";

describe("RunState — A2A vocabulary, adopted verbatim", () => {
  test("is exactly the A2A task state set", () => {
    // Must match A2A (and kaambaan's packages/contract/src/primitives.ts) with no
    // additions and no renames. A translation table between our states and the
    // board's is precisely what this is meant to avoid.
    expect(RunState.options).toEqual([
      "submitted",
      "working",
      "input-required",
      "auth-required",
      "completed",
      "rejected",
      "failed",
      "canceled",
    ]);
  });

  test("spells canceled with one l, matching A2A", () => {
    expect(RunState.safeParse("canceled").success).toBe(true);
    expect(RunState.safeParse("cancelled").success).toBe(false);
  });

  test("rejects an invented outcome vocabulary", () => {
    // The earlier proposal was completed/errored/cancelled. Adopting A2A means
    // "errored" must not parse.
    expect(RunState.safeParse("errored").success).toBe(false);
  });

  test("terminal states are the four that end a run", () => {
    expect([...TERMINAL_RUN_STATES]).toEqual(["completed", "rejected", "failed", "canceled"]);
    expect(isRunTerminal("completed")).toBe(true);
    expect(isRunTerminal("working")).toBe(false);
    expect(isRunTerminal("input-required")).toBe(false);
  });
});

describe("Run — a station attempt", () => {
  const base = {
    id: "attempt_9f1c2ab0-4d7e-4b3a-8c88-0d6e2f7c1b90",
    sessionId: "acps_abc",
    stationId: "station_xyz",
    state: "working" as const,
    startSeq: 4,
    startedAt: "2026-08-11T10:00:00.000Z",
  };

  test("mints its own id under `attempt_`, an id space kaambaan does not claim", () => {
    // The rename. `run_` belonged to kaambaan's work run and AgentPod reserved
    // the same prefix for this primary key, so the two were indistinguishable
    // strings. An AgentPod row's own key is now `attempt_<uuid>` and a kaambaan
    // run id cannot be one.
    expect(Run.parse(base).id).toBe("attempt_9f1c2ab0-4d7e-4b3a-8c88-0d6e2f7c1b90");
    expect(Run.safeParse({ ...base, id: "run_e074a2160c4b4f28" }).success).toBe(false);
  });

  test("the two id spaces are mutually exclusive, in both directions", () => {
    // Told apart by shape, not by which column they happen to sit in.
    expect(AcpRunId.safeParse("run_e074a2160c4b4f28").success).toBe(false);
    expect(
      KaambaanRunId.safeParse("attempt_9f1c2ab0-4d7e-4b3a-8c88-0d6e2f7c1b90").success,
    ).toBe(false);
  });

  test("refuses to record one of its own attempt ids as an external run id", () => {
    // The mirror of "we never mint a rival id": an external id from AgentPod's
    // own space is either a bug or a loop, and either way it is not a board's.
    expect(
      Run.safeParse({
        ...base,
        externalRunId: "attempt_3d4e5f60-7182-4a4b-8c56-51b6c7e8f0a2",
        externalSource: "kaambaan",
      }).success,
    ).toBe(false);
  });

  test("accepts a local attempt with no external run id", () => {
    // The console must keep working with no board attached at all.
    const r = Run.parse(base);
    expect(r.externalRunId).toBeUndefined();
    expect(r.externalSource).toBeUndefined();
  });

  test("carries kaambaan's runId when the attempt came from a claim", () => {
    const r = Run.parse({ ...base, externalRunId: "run_e074a216", externalSource: "kaambaan" });
    expect(r.externalRunId).toBe("run_e074a216");
    expect(r.externalSource).toBe("kaambaan");
  });

  test("rejects an external run id with no source, and a source with no id", () => {
    // Regression: both fields were independently optional, so a run could record
    // kaambaan's id without saying it was kaambaan's. Disjoint prefixes now say
    // the id is not AgentPod's, but not which of several possible orchestrators
    // it belongs to — `externalSource` is open (§7), so the reverse join through
    // acp_runs_external_idx still needs the source to reach the right board.
    expect(Run.safeParse({ ...base, externalRunId: "run_e074a2160c4b4f28" }).success).toBe(false);
    expect(Run.safeParse({ ...base, externalSource: "kaambaan" }).success).toBe(false);
  });

  test("endSeq and endedAt are absent while the run is live", () => {
    const r = Run.parse(base);
    expect(r.endSeq).toBeNull();
    expect(r.endedAt).toBeNull();
  });

  test("rejects a state outside the A2A vocabulary", () => {
    expect(Run.safeParse({ ...base, state: "errored" }).success).toBe(false);
  });
});

describe("Change — the thing that lands", () => {
  const base = {
    id: "chg_01J2",
    stationId: "station_xyz",
    baseRef: "0d1f2e3a4b5c6d7e8f90a1b2c3d4e5f607182930",
    status: "open" as const,
    createdAt: "2026-08-11T10:00:00.000Z",
  };

  test("resolves to a commit against a base, with no forge in the model", () => {
    const c = Change.parse(base);
    expect(c.baseRef).toHaveLength(40);
    expect(Object.keys(c)).not.toContain("pullRequestId");
  });

  test("a delivery reference is optional and vendor-neutral", () => {
    // §7: git-remote must remain sufficient on its own. A change that landed as a
    // pushed branch has a deliveryRef and no forge anywhere in the shape.
    const c = Change.parse({ ...base, status: "landed", deliveryAdapter: "git-remote", deliveryRef: "refs/heads/spike/x" });
    expect(c.deliveryAdapter).toBe("git-remote");
    expect(c.deliveryRef).toBe("refs/heads/spike/x");
  });

  test("accumulates many runs — runIds is a list, not a single run", () => {
    // A change outlives the run that produced it: first attempt, revision after
    // review, CI fix.
    const c = Change.parse({
      ...base,
      runIds: [
        "attempt_9f1c2ab0-4d7e-4b3a-8c88-0d6e2f7c1b90",
        "attempt_3d4e5f60-7182-4a4b-8c56-51b6c7e8f0a2",
        "attempt_7b2e9a10-3c5d-4e8f-b012-0d6e2f7c1b90",
      ],
    });
    expect(c.runIds).toHaveLength(3);
  });

  test("runIds holds AgentPod attempts, never a board's work run", () => {
    // A change is assembled from attempts that ran here. A `run_…` in this list
    // would be a kaambaan work run standing in for the attempts that produced
    // the commit — the same conflation the prefix split exists to prevent.
    expect(Change.safeParse({ ...base, runIds: ["run_e074a2160c4b4f28"] }).success).toBe(false);
  });

  test("defaults to an empty run list rather than requiring one", () => {
    expect(Change.parse(base).runIds).toEqual([]);
  });

  test("rejects an unknown delivery adapter", () => {
    expect(Change.safeParse({ ...base, deliveryAdapter: "sourceforge" }).success).toBe(false);
  });
});
