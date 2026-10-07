/**
 * The composition root's half of "nothing is posted into a board room before a human
 * has joined it" (2026-10-07).
 *
 * The rule lives in `projectGate` and `projectElicitation`, but each enforces it only
 * when handed `humanJoined` — optional, so a caller that builds no board room keeps
 * working. That made the production wiring the one place the fix could silently
 * vanish: drop the dep from the hub's projection deps and every test of the rule still
 * passes while production posts first gates to nobody again. These tests hold the
 * wiring itself: the deps the hub builds, and the event handler it mounts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { boardProjectionDeps, wakeHeldOnJoin, withJoinWake } from "./board-projection";

const ROOM = "!board:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const HUMAN = "@rakesh:id.agentpod.dev";

let realFetch: typeof fetch;
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
});

function bridge(): Parameters<typeof boardProjectionDeps>[0] {
  return {
    config: { domain: "id.agentpod.dev", homeserverUrl: "http://hs.test", asToken: "as-token" },
    client: {},
  } as unknown as Parameters<typeof boardProjectionDeps>[0];
}

describe("the projection deps the hub builds", () => {
  test("carry humanJoined, and it asks the homeserver who has joined the board room", async () => {
    realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ joined: { [SPEAKER]: {} } }), { status: 200 });
    }) as unknown as typeof fetch;

    const deps = boardProjectionDeps(bridge());
    expect(typeof deps.humanJoined).toBe("function");
    expect(await deps.humanJoined(ROOM, SPEAKER)).toBe(false);
    expect(urls[0]).toContain(`http://hs.test/_matrix/client/v3/rooms/${encodeURIComponent(ROOM)}/joined_members`);
  });
});

describe("a human joining a board room", () => {
  const join = { type: "m.room.member", sender: HUMAN, state_key: HUMAN, room_id: ROOM, content: { membership: "join" } };
  const lookup = async (roomId: string) => (roomId === ROOM ? { boardId: "brd_one", speakerMxid: SPEAKER } : null);

  test("wakes both the board's held gates and its held questions", async () => {
    const woken: string[] = [];
    await wakeHeldOnJoin(join, {
      lookup,
      sweepGates: async (b) => void woken.push(`gates:${b}`),
      sweepElicitations: async (b) => void woken.push(`questions:${b}`),
    });
    expect(woken.sort()).toEqual(["gates:brd_one", "questions:brd_one"]);
  });

  test("one sweep failing does not stop the other", async () => {
    const woken: string[] = [];
    await wakeHeldOnJoin(join, {
      lookup,
      sweepGates: async () => {
        throw new Error("board down");
      },
      sweepElicitations: async (b) => void woken.push(b),
    });
    expect(woken).toEqual(["brd_one"]);
  });

  test("the mounted handler wakes on a join and still hands every event on", async () => {
    const handled: string[] = [];
    const woken: string[] = [];
    const handler = withJoinWake(async (e) => void handled.push(e.type), async (e) => void woken.push(e.type));
    await handler(join);
    expect(handled).toEqual(["m.room.member"]);
    expect(woken).toEqual(["m.room.member"]);
  });
});

/**
 * `src/index.ts` cannot be imported by a test — it boots the hub. So the last link is
 * read from its source: every projection takes the deps built above, and the
 * appservice's event handler is wrapped. Remove either and this goes red.
 */
describe("src/index.ts", () => {
  const source = readFileSync(join(import.meta.dir, "../../index.ts"), "utf8");

  test("builds its projection deps with boardProjectionDeps", () => {
    expect(source).toMatch(/const gateProjection = boardProjectionDeps\(matrixBridge\)/);
  });

  test("hands those deps to every projection: push, the gate sweep and the question sweep", () => {
    expect(source).toMatch(/projectGate\(tenantId, delivery, gateProjection\)/);
    expect(source).toMatch(/projectElicitation\(tenantId, delivery, gateProjection\)/);
    expect(source).toMatch(/createSuperpipelinePushRoutes\(\{[\s\S]*?\.\.\.gateProjection/);
  });

  test("mounts the appservice handler wrapped so a join wakes held posts", () => {
    expect(source).toMatch(/onEvent: withJoinWake\(/);
  });
});
