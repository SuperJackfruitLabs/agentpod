import { test, expect } from "bun:test";
import { createSessionFailure } from "../../src/routes/station-acp";
import { SalaamAuthorityDenied } from "../../src/services/salaam-authority";
import { ControlPairDenied } from "../../src/services/control-pair";

// Spec 2026-10-23 C10/C16: the console measured a 502 for "no dispatch grant", which an edge then
// replaced with HTML. A refusal is 403; a node failure is 424/503; nothing is 502.

test("a Salaam authority refusal is 403 with a code, not a node failure", () => {
  const msg = "Salaam execution authority was suspended or its dispatch grant was withdrawn";
  expect(createSessionFailure(new SalaamAuthorityDenied(msg))).toEqual({
    status: 403,
    body: { error: msg, code: "salaam_authority_denied" },
  });
});

test("a control-pair refusal stays 403", () => {
  expect(createSessionFailure(new ControlPairDenied("u", "k")).status).toBe(403);
});

test("an offline node is 503 station_unavailable", () => {
  expect(createSessionFailure(new Error("Node is offline."))).toEqual({
    status: 503,
    body: { error: "Node is offline.", code: "station_unavailable" },
  });
});

test("an agent that failed to open is 424 node_failed", () => {
  expect(createSessionFailure(new Error("acp.open failed: handshake"))).toEqual({
    status: 424,
    body: { error: "acp.open failed: handshake", code: "node_failed" },
  });
});

test("the known caller errors keep their statuses", () => {
  expect(createSessionFailure(new Error("Station not found.")).status).toBe(404);
  expect(createSessionFailure(new Error("This station does not support agent sessions.")).status).toBe(403);
  expect(createSessionFailure(new Error("An active session already exists for this agent.")).status).toBe(409);
});
