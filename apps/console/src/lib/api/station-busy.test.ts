import { test, expect } from "vitest";
import { apiError, stationBusyMessage } from "./http-error";

// Session lifecycle (2026-10-23): a Salaam station runs one session at a time, and the refusal
// says whose and since when instead of a raw sentence.

const since = new Date();
since.setHours(14, 2, 0, 0);
const time = since.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

test("another person's session: named, with the local time it started", async () => {
  const res = new Response(
    JSON.stringify({
      error: "Asha is in a session with this agent since 2026-10-23T14:02:00Z. It takes one at a time.",
      code: "station_busy",
      holder: { name: "Asha", you: false, since: since.toISOString(), state: "active" },
    }),
    { status: 424 },
  );
  const err = await apiError(res, "POST /api/stations/s1/acp/sessions");
  expect(err.code).toBe("station_busy");
  expect(err.message).toBe(`Asha is in a session with this agent since ${time}. It takes one at a time.`);
  expect(err.holder).toEqual({ name: "Asha", you: false, since: since.toISOString(), state: "active" });
});

test('your own session: "You are", with its id so the panel can open it', async () => {
  const res = new Response(
    JSON.stringify({
      error: "x",
      code: "station_busy",
      holder: { name: "You", you: true, since: since.toISOString(), state: "active", sessionId: "acps_mine" },
    }),
    { status: 424 },
  );
  const err = await apiError(res, "POST /api/stations/s1/acp/sessions");
  expect(err.message).toBe(`You are in a session with this agent since ${time}. It takes one at a time.`);
  expect(err.holder?.sessionId).toBe("acps_mine");
});

test("a stop still unconfirmed says so, and an earlier day carries its date", () => {
  const yesterday = new Date(since.getTime() - 24 * 3600_000);
  const msg = stationBusyMessage({ name: "Asha", you: false, since: yesterday.toISOString(), state: "stopping" }, since);
  expect(msg).toContain("Asha's last session with this agent is still stopping (since ");
  expect(msg).toContain(yesterday.toLocaleDateString(undefined, { day: "numeric", month: "short" }));
});
