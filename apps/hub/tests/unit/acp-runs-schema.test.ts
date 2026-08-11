import { expect, test, describe } from "bun:test";
import { RunState, isRunTerminal } from "@agentpod/contract";
import { acpRuns, acpEvents } from "../../src/db/schema/acp";

describe("acp_runs — the join key", () => {
  test("carries an external run id and its source, both optional", () => {
    // Optional because the console must keep working with no board attached.
    const cols = Object.keys(acpRuns);
    expect(cols).toContain("externalRunId");
    expect(cols).toContain("externalSource");
    expect(acpRuns.externalRunId.notNull).toBe(false);
    expect(acpRuns.externalSource.notNull).toBe(false);
  });

  test("binds an attempt to a session and a station", () => {
    const cols = Object.keys(acpRuns);
    expect(cols).toContain("sessionId");
    expect(cols).toContain("stationId");
    expect(acpRuns.sessionId.notNull).toBe(true);
    expect(acpRuns.stationId.notNull).toBe(true);
  });

  test("records the prompt-turn boundary as event sequence numbers", () => {
    // A run is a prompt-turn, so its extent is a span of acp_events.seq. endSeq
    // is nullable because a live run has no end yet.
    expect(acpRuns.startSeq.notNull).toBe(true);
    expect(acpRuns.endSeq.notNull).toBe(false);
    expect(acpRuns.endedAt.notNull).toBe(false);
  });

  test("state is stored as text carrying the A2A vocabulary", () => {
    expect(acpRuns.state.notNull).toBe(true);
    // The column is text; the contract is what constrains it. Guard the
    // vocabulary here so a rename in one place fails a test rather than
    // silently creating a translation table.
    expect(RunState.options).toContain("input-required");
    expect(RunState.options).toContain("auth-required");
    expect(isRunTerminal("canceled")).toBe(true);
  });
});

describe("acp_events retention shape", () => {
  test("created_at exists and is not null, so age-based pruning is possible", () => {
    // Horizon 0 settles the shape; Horizon 3 enforces the policy. Without this
    // column being indexed, pruning or exporting by age is a full scan of the
    // largest table in the database.
    expect(Object.keys(acpEvents)).toContain("createdAt");
    expect(acpEvents.createdAt.notNull).toBe(true);
  });
});
