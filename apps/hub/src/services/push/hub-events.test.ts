/**
 * The hub's own events, and the quiet sends in flight that a push may race.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  _resetHubEventsForTest,
  beginQuietSend,
  hubEventKind,
  hubEventTurn,
  noteAnswerEvent,
  noteHubEvent,
  quietSendsInFlight,
  quietSendsSettled,
} from "./hub-events";

const ROOM = "!room:id.agentpod.dev";

beforeEach(() => _resetHubEventsForTest());

describe("noteHubEvent", () => {
  test("remembers a quiet event", () => {
    noteHubEvent("$r", "quiet");
    expect(hubEventKind("$r")).toBe("quiet");
    expect(hubEventKind("$other")).toBeUndefined();
  });

  test("forgets it after its TTL", () => {
    noteHubEvent("$r", "quiet", 0);
    expect(hubEventKind("$r", 6 * 60 * 60 * 1000)).toBeUndefined();
  });
});

describe("quiet sends in flight", () => {
  test("are counted per room until each ends, and ending twice counts once", () => {
    const a = beginQuietSend(ROOM);
    const b = beginQuietSend(ROOM);
    expect(quietSendsInFlight(ROOM)).toBe(2);
    expect(quietSendsInFlight("!elsewhere:x")).toBe(0);
    a();
    a();
    expect(quietSendsInFlight(ROOM)).toBe(1);
    b();
    expect(quietSendsInFlight(ROOM)).toBe(0);
  });

  test("a room with nothing in flight settles at once", async () => {
    const t = performance.now();
    await quietSendsSettled(ROOM, "$x", 5_000);
    expect(performance.now() - t).toBeLessThan(50);
  });

  test("settles when the send in flight ends", async () => {
    const end = beginQuietSend(ROOM);
    let settled = false;
    const p = quietSendsSettled(ROOM, "$x", 5_000).then(() => (settled = true));
    await Bun.sleep(20);
    expect(settled).toBe(false);
    end();
    await p;
    expect(settled).toBe(true);
  });

  test("settles as soon as the awaited id is noted, even with another send still in flight", async () => {
    const endA = beginQuietSend(ROOM);
    beginQuietSend(ROOM); // never ends
    const t = performance.now();
    const p = quietSendsSettled(ROOM, "$a", 5_000);
    noteHubEvent("$a", "quiet");
    endA();
    await p;
    expect(performance.now() - t).toBeLessThan(1_000);
  });

  test("gives up after its timeout when the send never returns", async () => {
    beginQuietSend(ROOM);
    const t = performance.now();
    await quietSendsSettled(ROOM, "$x", 60);
    const took = performance.now() - t;
    expect(took).toBeGreaterThanOrEqual(55);
    expect(took).toBeLessThan(1_000);
  });
});

describe("an answer and the turn it ended", () => {
  test("is remembered as an answer, with the turn's counts and nothing else", () => {
    noteAnswerEvent("$a", { total: 7, failed: 1 });
    expect(hubEventKind("$a")).toBe("answer");
    expect(hubEventTurn("$a")).toEqual({ total: 7, failed: 1 });
    expect(hubEventTurn("$other")).toBeUndefined();
  });

  test("a kind noted without counts has none", () => {
    noteHubEvent("$q", "quiet");
    expect(hubEventTurn("$q")).toBeUndefined();
  });

  test("forgets the counts with the kind", () => {
    noteAnswerEvent("$a", { total: 1, failed: 0 }, 0);
    expect(hubEventTurn("$a", 6 * 60 * 60 * 1000)).toBeUndefined();
  });
});
