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

test("the new user is invited, joins, and the old one leaves — in that order", async () => {
  const acts: string[] = [];
  await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_guild_hermes-writer-quill:h" }],
    invite: async (as, r, invitee) => { acts.push(`invite ${as} ${r} ${invitee}`); },
    join: async (u, r) => { acts.push(`join ${u} ${r}`); },
    leave: async (u, r) => { acts.push(`leave ${u} ${r}`); },
    setDirect: async (u, r) => { acts.push(`direct ${u} ${r}`); },
  });
  // INVITE before join: these rooms are invite-only, and an uninvited join is
  // refused with `403 M_FORBIDDEN ... cannot join a room that is not \`public\``.
  // That is not hypothetical — it is what the live homeserver answered for all
  // 32 rooms, while this file's fakes happily accepted a bare join.
  //
  // The inviter is the OLD user: it is still a member and created the room, so
  // it holds the power level to invite. The new user has neither.
  //
  // Join BEFORE leave: the reverse leaves the room briefly with no agent in it.
  expect(acts).toEqual([
    "invite @agent_guild_hermes-writer-quill:h !r:h @agent_writer-quill:h",
    "join @agent_writer-quill:h !r:h",
    "direct @agent_writer-quill:h !r:h",
    "leave @agent_guild_hermes-writer-quill:h !r:h",
  ]);
});

test("a room is never joined without an invite first", async () => {
  // The regression that shipped: a join with no preceding invite. Asserted on
  // its own so it fails loudly if the invite is ever dropped as redundant.
  let invited = false;
  await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_guild_hermes-writer-quill:h" }],
    invite: async () => { invited = true; },
    join: async () => {
      expect(invited).toBe(true);
    },
    leave: async () => {},
    setDirect: async () => {},
  });
  expect(invited).toBe(true);
});

test("is idempotent — a room already migrated is skipped", async () => {
  const r = await migrateAgentMxids({ rooms: async () => [], invite: fail, join: fail, leave: fail, setDirect: fail });
  expect(r.migrated).toBe(0);
});

test("a room whose new address matches its recorded one is skipped, not re-sent", async () => {
  const r = await migrateAgentMxids({
    rooms: async () => [{ roomId: "!r:h", handle: "writer-quill", oldUserId: "@agent_writer-quill:h" }],
    invite: fail,
    join: fail,
    leave: fail,
    setDirect: fail,
  });
  expect(r).toEqual({ migrated: 0, skipped: 1 });
});
