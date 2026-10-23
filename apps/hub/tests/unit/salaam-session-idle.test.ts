import { test, expect } from "bun:test";
import {
  idleEndDue,
  idleEndReason,
  salaamIdleEndMs,
  SalaamStationBusy,
  SessionNotResumable,
  type IdleCandidate,
} from "../../src/services/acp-sessions";
import { createSessionFailure } from "../../src/routes/station-acp";

// Session lifecycle (operator, 2026-10-23): an idle Salaam session ends on its own, but never
// mid-turn or while a permission prompt waits, and never board work.

const MIN = 60_000;
const quiet: IdleCandidate = {
  ended: false,
  status: "idle",
  turnInFlight: false,
  pendingPermissions: 0,
  interactive: true,
  lastActivityAt: 0,
};

test("an interactive session idle for the timeout is due, and not a moment before", () => {
  expect(idleEndDue(quiet, 15 * MIN, 15 * MIN)).toBe(true);
  expect(idleEndDue(quiet, 15 * MIN - 1, 15 * MIN)).toBe(false);
});

test("never mid-turn, never with a permission prompt pending, never board work, never twice", () => {
  const late = 60 * MIN;
  expect(idleEndDue({ ...quiet, turnInFlight: true }, late, 15 * MIN)).toBe(false);
  expect(idleEndDue({ ...quiet, status: "working" }, late, 15 * MIN)).toBe(false);
  expect(idleEndDue({ ...quiet, status: "waiting", pendingPermissions: 1 }, late, 15 * MIN)).toBe(false);
  expect(idleEndDue({ ...quiet, pendingPermissions: 1 }, late, 15 * MIN)).toBe(false);
  expect(idleEndDue({ ...quiet, interactive: false }, late, 15 * MIN)).toBe(false);
  expect(idleEndDue({ ...quiet, ended: true }, late, 15 * MIN)).toBe(false);
});

test("SALAAM_IDLE_END_MINUTES configures the timeout; anything unusable is the 15-minute default", () => {
  expect(salaamIdleEndMs({})).toBe(15 * MIN);
  expect(salaamIdleEndMs({ SALAAM_IDLE_END_MINUTES: "30" })).toBe(30 * MIN);
  expect(salaamIdleEndMs({ SALAAM_IDLE_END_MINUTES: "0.5" })).toBe(30_000);
  for (const bad of ["0", "-3", "soon", ""]) expect(salaamIdleEndMs({ SALAAM_IDLE_END_MINUTES: bad })).toBe(15 * MIN);
});

test("the row's reason says how long, and that it can be resumed", () => {
  expect(idleEndReason(15 * MIN)).toBe("Ended after 15 minutes without activity. Resume it to carry on.");
  expect(idleEndReason(30_000)).toBe("Ended after 30 seconds without activity. Resume it to carry on.");
});

test("a busy station is 424 station_busy naming the holder; a refused resume is 409", () => {
  const since = "2026-10-23T09:00:00.000Z";
  const busy = new SalaamStationBusy({ name: "Asha", you: false, since, state: "active" });
  expect(createSessionFailure(busy)).toEqual({
    status: 424,
    body: {
      error: `Asha is in a session with this agent since ${since}. It takes one at a time.`,
      code: "station_busy",
      holder: { name: "Asha", you: false, since, state: "active" },
    },
  });
  expect(new SalaamStationBusy({ name: "You", you: true, since, state: "active", sessionId: "acps_x" }).message).toBe(
    `You are in a session with this agent since ${since}. It takes one at a time.`,
  );
  expect(createSessionFailure(new SessionNotResumable("This session was already resumed."))).toEqual({
    status: 409,
    body: { error: "This session was already resumed.", code: "not_resumable" },
  });
});
