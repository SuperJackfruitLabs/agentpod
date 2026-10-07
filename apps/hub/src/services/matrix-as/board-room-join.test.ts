/**
 * Who has joined a board room, and which join should wake a held gate.
 *
 * A board's first gate is held until a human has joined (`gates.ts`, 2026-10-07):
 * posting it while they were only invited encrypted it to the speaker alone.
 */
import { describe, expect, test } from "bun:test";

import { boardForHumanJoin, boardRoomHasJoinedHuman } from "./board-room";

const ROOM = "!board:id.agentpod.dev";
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const HUMAN = "@rakesh:id.agentpod.dev";

function homeserver(answer: { status: number; joined?: string[] }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify(answer.joined ? { joined: Object.fromEntries(answer.joined.map((m) => [m, {}])) } : {}),
      { status: answer.status },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const deps = (fetchImpl: typeof fetch) => ({ homeserverUrl: "http://hs.test", asToken: "t", fetch: fetchImpl });

describe("has a human joined the board room", () => {
  test("not while the speaker is the only member — the 2026-10-07 room", async () => {
    const hs = homeserver({ status: 200, joined: [SPEAKER] });
    expect(await boardRoomHasJoinedHuman(ROOM, SPEAKER, deps(hs.fetchImpl))).toBe(false);
  });

  test("yes once somebody other than the speaker has joined", async () => {
    const hs = homeserver({ status: 200, joined: [SPEAKER, HUMAN] });
    expect(await boardRoomHasJoinedHuman(ROOM, SPEAKER, deps(hs.fetchImpl))).toBe(true);
    // Asked as the speaker, who is in the room; the bridge's own sender is not.
    expect(hs.urls[0]).toContain(`/rooms/${encodeURIComponent(ROOM)}/joined_members`);
    expect(hs.urls[0]).toContain(`user_id=${encodeURIComponent(SPEAKER)}`);
  });

  test("another of this hub's own users is not a human", async () => {
    const hs = homeserver({ status: 200, joined: [SPEAKER, "@agent_krishna:id.agentpod.dev"] });
    expect(await boardRoomHasJoinedHuman(ROOM, SPEAKER, deps(hs.fetchImpl))).toBe(false);
  });

  test("a membership that cannot be read throws rather than guessing either way", async () => {
    const hs = homeserver({ status: 502 });
    await expect(boardRoomHasJoinedHuman(ROOM, SPEAKER, deps(hs.fetchImpl))).rejects.toThrow(/joined members/);
  });
});

describe("which join wakes a board's held gates", () => {
  const lookup = async (roomId: string) =>
    roomId === ROOM ? { boardId: "brd_one", speakerMxid: SPEAKER } : null;
  const member = (sender: string, membership: string, roomId = ROOM) => ({
    type: "m.room.member",
    sender,
    room_id: roomId,
    state_key: sender,
    content: { membership },
  });

  test("a human joining a board room names that board", async () => {
    expect(await boardForHumanJoin(member(HUMAN, "join"), lookup)).toBe("brd_one");
  });

  test("an invite is not a join", async () => {
    expect(await boardForHumanJoin(member(HUMAN, "invite"), lookup)).toBeNull();
  });

  test("the speaker joining its own room is not a human arriving", async () => {
    expect(await boardForHumanJoin(member(SPEAKER, "join"), lookup)).toBeNull();
  });

  test("a join in a room that is not a board room is none of this", async () => {
    expect(await boardForHumanJoin(member(HUMAN, "join", "!station:id.agentpod.dev"), lookup)).toBeNull();
  });

  test("a message is not a membership change", async () => {
    expect(
      await boardForHumanJoin({ type: "m.room.message", sender: HUMAN, room_id: ROOM, content: { membership: "join" } }, lookup),
    ).toBeNull();
  });
});
