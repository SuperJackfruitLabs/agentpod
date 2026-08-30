/**
 * The one irreversible step in slice A: re-addressing the fleet's DM rooms.
 *
 * Every dependency here is a fake. This proves the ordering and the `m.direct`
 * fix-up in isolation — it does not, and must not, touch a homeserver.
 */

import { expect, test } from "bun:test";

import { migrateAgentMxids } from "./migrate-agent-mxids";

const fail = async () => {
  throw new Error("must not be called");
};

test("the new user joins the existing room and the old one leaves", async () => {
  const acts: string[] = [];
  await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_guild_hermes-writer-quill:h" }],
    join: async (u, r) => { acts.push(`join ${u} ${r}`); },
    leave: async (u, r) => { acts.push(`leave ${u} ${r}`); },
    setDirect: async (u, r) => { acts.push(`direct ${u} ${r}`); },
  });
  // Join BEFORE leave: the reverse leaves the room briefly with no agent in it.
  expect(acts).toEqual([
    "join @agent_writer-quill:h !r:h",
    "direct @agent_writer-quill:h !r:h",
    "leave @agent_guild_hermes-writer-quill:h !r:h",
  ]);
});

test("is idempotent — a room already migrated is skipped", async () => {
  const r = await migrateAgentMxids({ rooms: async () => [], join: fail, leave: fail, setDirect: fail });
  expect(r.migrated).toBe(0);
});

test("a room whose new address matches its recorded one is skipped, not re-sent", async () => {
  const r = await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_writer-quill:h" }],
    join: fail,
    leave: fail,
    setDirect: fail,
  });
  expect(r).toEqual({ migrated: 0, skipped: 1 });
});
