/**
 * The caller `migrateAgentMxids` never had — proved against fakes only.
 *
 * Nothing here reaches a database or a homeserver: `describeRooms` is fed a
 * fake `rows()` and a fake `isJoined`, and `runMigration` is fed a fake
 * `DirectClient`. That is deliberate — this suite exists to prove the
 * ordering and the read-modify-write in isolation, exactly like
 * `migrate-agent-mxids.test.ts` does for the pure function underneath it.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  buildMigrationDeps,
  describeRooms,
  formatReport,
  runMigration,
  type DescribeDeps,
  type DirectClient,
  type StationRoomRow,
} from "./migrate-agent-mxids-run";

const DOMAIN = "id.agentpod.dev";

const ROW: StationRoomRow = {
  roomId: "!r:id.agentpod.dev",
  stationId: "stn_1",
  stationKey: "hermes:writer-quill",
  nodeName: "guild",
  principalId: "prn_writer",
  ownerUserId: "usr_rakesh",
};

/** A `describeRooms` deps object with everything overridable. */
function describeDeps(overrides: Partial<DescribeDeps> & { joined?: Set<string> } = {}): DescribeDeps {
  const joined = overrides.joined ?? new Set<string>();
  return {
    domain: DOMAIN,
    rows: overrides.rows ?? (async () => [ROW]),
    isJoined: overrides.isJoined ?? (async (userId, roomId) => joined.has(`${userId}|${roomId}`)),
    principalHandle: overrides.principalHandle ?? (async () => "writer-quill"),
    ownerMxidFor: overrides.ownerMxidFor ?? (async () => "@rakesh:id.agentpod.dev"),
  };
}

const OLD_USER = "@agent_guild_hermes-writer-quill:id.agentpod.dev";
const NEW_USER = "@agent_writer-quill:id.agentpod.dev";

describe("describeRooms — live membership, not a flag", () => {
  test("a room where nothing has happened yet is reported with all three steps outstanding", async () => {
    const rooms = await describeRooms(describeDeps());

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      roomId: ROW.roomId,
      oldUserId: OLD_USER,
      newUserId: NEW_USER,
      joinOutstanding: true,
      leaveOutstanding: false, // the OLD user was never reported joined by this fake either
      directOutstanding: true,
    });
  });

  test("a room where the new user has joined but the old has not left is still reported — half-migrated", async () => {
    // The exact crash Task 9's review named: a run that died between join and
    // leave. Detected from membership, because nothing wrote a flag for it.
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`, `${OLD_USER}|${ROW.roomId}`]);

    const rooms = await describeRooms(describeDeps({ joined }));

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      joinOutstanding: false,
      leaveOutstanding: true,
      directOutstanding: true,
    });
  });

  test("a room where the new user has joined and the old has left is fully done, and omitted", async () => {
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`]); // old is NOT in this set — it left

    const rooms = await describeRooms(describeDeps({ joined }));

    expect(rooms).toEqual([]);
  });

  test("a station with no occupying principal is omitted, not migrated to a guessed address", async () => {
    const rooms = await describeRooms(
      describeDeps({ rows: async () => [{ ...ROW, principalId: null }] })
    );

    expect(rooms).toEqual([]);
  });

  test("a principal with no handle is omitted the same way", async () => {
    const rooms = await describeRooms(describeDeps({ principalHandle: async () => null }));

    expect(rooms).toEqual([]);
  });

  test("the old address is derived from the station's own (node, key), not guessed from membership", async () => {
    const rooms = await describeRooms(
      describeDeps({ rows: async () => [{ ...ROW, nodeName: "Box!", stationKey: "OpenCode:C52DDF65" }] })
    );

    expect(rooms[0]!.oldUserId).toBe("@agent_box-_opencode-c52ddf65:id.agentpod.dev");
  });
});

describe("buildMigrationDeps — m.direct is read-modify-write", () => {
  function client(overrides: Partial<DirectClient> = {}, accountData: Record<string, unknown> = {}): DirectClient & { written: Record<string, unknown> | null } {
    const state = { written: null as Record<string, unknown> | null };
    return {
      join: overrides.join ?? (async () => {}),
      leave: overrides.leave ?? (async () => {}),
      getAccountData: overrides.getAccountData ?? (async () => (Object.keys(accountData).length ? accountData : null)),
      setAccountData: overrides.setAccountData ?? (async (_u, _t, content) => {
        state.written = content;
      }),
      get written() {
        return state.written;
      },
    };
  }

  test("every other DM in m.direct survives untouched", async () => {
    // The single most destructive thing available in this task: blindly
    // writing one entry would discard every other conversation the operator
    // has. This is the test that would catch it.
    const c = client(
      {},
      {
        [OLD_USER]: ["!r:id.agentpod.dev"],
        "@some-other-agent:id.agentpod.dev": ["!unrelated:id.agentpod.dev"],
      }
    );

    const deps = buildMigrationDeps(
      [
        {
          roomId: "!r:id.agentpod.dev",
          stationKey: ROW.stationKey,
          nodeName: ROW.nodeName,
          handle: "writer-quill",
          oldUserId: OLD_USER,
          newUserId: NEW_USER,
          ownerMxid: "@rakesh:id.agentpod.dev",
          joinOutstanding: true,
          leaveOutstanding: false,
          directOutstanding: true,
        },
      ],
      c
    );

    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(c.written).toEqual({
      // The old key is gone because this room was its only entry...
      "@some-other-agent:id.agentpod.dev": ["!unrelated:id.agentpod.dev"], // ...and this one was never touched.
      [NEW_USER]: ["!r:id.agentpod.dev"],
    });
  });

  test("the old key survives if it still names another room", async () => {
    const c = client(
      {},
      { [OLD_USER]: ["!r:id.agentpod.dev", "!other-room:id.agentpod.dev"] }
    );

    const deps = buildMigrationDeps(
      [
        {
          roomId: "!r:id.agentpod.dev",
          stationKey: ROW.stationKey,
          nodeName: ROW.nodeName,
          handle: "writer-quill",
          oldUserId: OLD_USER,
          newUserId: NEW_USER,
          ownerMxid: "@rakesh:id.agentpod.dev",
          joinOutstanding: true,
          leaveOutstanding: false,
          directOutstanding: true,
        },
      ],
      c
    );

    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(c.written).toEqual({
      [OLD_USER]: ["!other-room:id.agentpod.dev"],
      [NEW_USER]: ["!r:id.agentpod.dev"],
    });
  });

  test("a room with no linked owner is logged and left alone, not guessed at", async () => {
    const c = client();
    let setCalled = false;
    c.setAccountData = async () => {
      setCalled = true;
    };

    const deps = buildMigrationDeps(
      [
        {
          roomId: "!r:id.agentpod.dev",
          stationKey: ROW.stationKey,
          nodeName: ROW.nodeName,
          handle: "writer-quill",
          oldUserId: OLD_USER,
          newUserId: NEW_USER,
          ownerMxid: null,
          joinOutstanding: true,
          leaveOutstanding: false,
          directOutstanding: true,
        },
      ],
      c
    );

    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(setCalled).toBe(false);
  });
});

describe("runMigration — dry run changes nothing, apply isolates failures", () => {
  test("dry run reports the room and calls no client method at all", async () => {
    let calls = 0;
    const c: DirectClient = {
      join: async () => { calls++; },
      leave: async () => { calls++; },
      getAccountData: async () => { calls++; return null; },
      setAccountData: async () => { calls++; },
    };

    const result = await runMigration(describeDeps(), c, { apply: false });

    expect(result.applied).toBe(false);
    expect(result.rooms).toHaveLength(1);
    expect(result.migrated).toBe(0);
    expect(calls).toBe(0);
  });

  test("applying runs join, then setDirect, then leave, in that order", async () => {
    const acts: string[] = [];
    const c: DirectClient = {
      join: async (u, r) => { acts.push(`join ${u} ${r}`); },
      leave: async (u, r) => { acts.push(`leave ${u} ${r}`); },
      getAccountData: async () => null,
      setAccountData: async (u) => { acts.push(`direct ${u}`); },
    };

    const result = await runMigration(describeDeps(), c, { apply: true });

    expect(result.applied).toBe(true);
    expect(result.migrated).toBe(1);
    expect(acts).toEqual([
      `join ${NEW_USER} ${ROW.roomId}`,
      // setAccountData is called as the OWNER, not the agent — m.direct is the
      // human's own account data, not the agent's.
      `direct @rakesh:id.agentpod.dev`,
      `leave ${OLD_USER} ${ROW.roomId}`,
    ]);
  });

  test("a failure on one room does not stop the rest, and is reported", async () => {
    const rows: StationRoomRow[] = [
      ROW,
      { ...ROW, roomId: "!r2:id.agentpod.dev", stationId: "stn_2", stationKey: "hermes:second" },
    ];
    let joinCalls = 0;
    const c: DirectClient = {
      join: async (_u, roomId) => {
        joinCalls++;
        if (roomId === ROW.roomId) throw new Error("rate limited");
      },
      leave: async () => {},
      getAccountData: async () => null,
      setAccountData: async () => {},
    };

    const result = await runMigration(describeDeps({ rows: async () => rows }), c, { apply: true });

    // Both rooms were attempted, sequentially — the failure on the first did
    // not abandon the second.
    expect(joinCalls).toBe(2);
    expect(result.migrated).toBe(1);
    expect(result.failures).toEqual([
      { roomId: ROW.roomId, stationKey: ROW.stationKey, error: "rate limited" },
    ]);
  });
});

describe("formatReport — what an operator reads before deciding", () => {
  test("a dry run names the room, both addresses, and the outstanding steps, and says nothing changed", () => {
    const report = formatReport({
      applied: false,
      migrated: 0,
      skipped: 0,
      failures: [],
      rooms: [
        {
          roomId: ROW.roomId,
          stationKey: ROW.stationKey,
          nodeName: ROW.nodeName,
          handle: "writer-quill",
          oldUserId: OLD_USER,
          newUserId: NEW_USER,
          ownerMxid: "@rakesh:id.agentpod.dev",
          joinOutstanding: true,
          leaveOutstanding: false,
          directOutstanding: true,
        },
      ],
    });

    expect(report).toContain("DRY RUN");
    expect(report).toContain("Nothing has been changed");
    expect(report).toContain(ROW.roomId);
    expect(report).toContain(OLD_USER);
    expect(report).toContain(NEW_USER);
    expect(report).toContain("join, m.direct");
  });

  test("no outstanding rooms is reported plainly", () => {
    expect(formatReport({ applied: false, migrated: 0, skipped: 0, failures: [], rooms: [] })).toContain(
      "No rooms need migration"
    );
  });
});
