/**
 * The superdial power-level script's choices: which rooms it touches, and whether it writes.
 *
 * `--room` exists so an operator can change named rooms only (E2 ruling D6: four production
 * rooms, not every bridge room). Every dependency is a fake; nothing here reaches a homeserver.
 */

import { describe, expect, test } from "bun:test";

import { parseCallPowerLevelArgs, runCallPowerLevels, type BridgeRoom } from "./superdial-call-power-levels";

const ROOMS: BridgeRoom[] = [
  { roomId: "!a:h", stationKey: "station-a", speaker: "@agent_a:h" },
  { roomId: "!b:h", stationKey: "station-b", speaker: "@agent_b:h" },
  { roomId: "!c:h", stationKey: "station-c", speaker: "@agent_c:h" },
];

function fakeEnsure() {
  const calls: Array<{ speaker: string; roomId: string; apply: boolean | undefined }> = [];
  return {
    calls,
    ensure: async (speaker: string, roomId: string, opts: { apply?: boolean } = {}) => {
      calls.push({ speaker, roomId, apply: opts.apply });
      return opts.apply ? ("updated" as const) : ("would-update" as const);
    },
  };
}

describe("its arguments", () => {
  test("a dry run of every bridge room by default", () => {
    expect(parseCallPowerLevelArgs([])).toEqual({ apply: false, rooms: [] });
  });

  test("--room is repeatable, in both spellings, and --apply writes", () => {
    expect(parseCallPowerLevelArgs(["--room", "!a:h", "--apply", "--room=!c:h"])).toEqual({
      apply: true,
      rooms: ["!a:h", "!c:h"],
    });
  });

  test("--room without a room id is refused", () => {
    expect(() => parseCallPowerLevelArgs(["--room"])).toThrow(/--room needs a room id/);
    expect(() => parseCallPowerLevelArgs(["--room", "--apply"])).toThrow(/--room needs a room id/);
    expect(() => parseCallPowerLevelArgs(["--room="])).toThrow(/--room needs a room id/);
  });

  test("an argument it does not know is refused, so a typo never widens the run to every room", () => {
    expect(() => parseCallPowerLevelArgs(["--rooms", "!a:h", "--apply"])).toThrow(/unknown argument: --rooms/);
  });
});

describe("which rooms it touches", () => {
  test("without --room, every bridge room", async () => {
    const { calls, ensure } = fakeEnsure();
    const out: string[] = [];
    const result = await runCallPowerLevels({ rows: ROOMS, ensure, log: (l) => out.push(l) }, { apply: false, rooms: [] });
    expect(calls.map((c) => c.roomId)).toEqual(["!a:h", "!b:h", "!c:h"]);
    expect(calls.every((c) => c.apply === false)).toBe(true);
    expect(result.failed).toBe(0);
  });

  test("with --room, only those rooms, dry run and apply alike", async () => {
    for (const apply of [false, true]) {
      const { calls, ensure } = fakeEnsure();
      await runCallPowerLevels({ rows: ROOMS, ensure, log: () => {} }, { apply, rooms: ["!c:h", "!a:h"] });
      expect(calls).toEqual([
        { speaker: "@agent_a:h", roomId: "!a:h", apply },
        { speaker: "@agent_c:h", roomId: "!c:h", apply },
      ]);
    }
  });

  test("a named room that is not a bridge agent room is reported as failed and left alone", async () => {
    const { calls, ensure } = fakeEnsure();
    const out: string[] = [];
    const result = await runCallPowerLevels(
      { rows: ROOMS, ensure, log: (l) => out.push(l) },
      { apply: true, rooms: ["!b:h", "!typo:h"] },
    );
    expect(calls.map((c) => c.roomId)).toEqual(["!b:h"]);
    expect(result.failed).toBe(1);
    expect(out.join("\n")).toContain("FAIL !typo:h: not a bridge agent room");
  });

  test("its summary names the rooms it was limited to", async () => {
    const { ensure } = fakeEnsure();
    const out: string[] = [];
    await runCallPowerLevels({ rows: ROOMS, ensure, log: (l) => out.push(l) }, { apply: false, rooms: ["!a:h"] });
    expect(out[0]).toBe("dry run: 1 of 3 bridge room(s), limited by --room\n");
  });
});
