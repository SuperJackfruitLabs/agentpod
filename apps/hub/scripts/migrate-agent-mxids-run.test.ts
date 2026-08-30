/**
 * The caller `migrateAgentMxids` never had — proved against fakes only.
 *
 * Nothing here reaches a database or a homeserver: `describeRooms` is fed a
 * fake `rows()` and a fake `client`, and `runMigration` is fed a fake
 * `DirectClient`. That is deliberate — this suite exists to prove the
 * ordering and the read-modify-write in isolation, exactly like
 * `migrate-agent-mxids.test.ts` does for the pure function underneath it.
 */
import { describe, expect, test } from "bun:test";

import {
  buildMigrationDeps,
  describeRooms,
  formatReport,
  runMigration,
  type DescribeClient,
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

const OLD_USER = "@agent_guild_hermes-writer-quill:id.agentpod.dev";
const NEW_USER = "@agent_writer-quill:id.agentpod.dev";
const OWNER = "@rakesh:id.agentpod.dev";

/** A fake `DescribeClient`: live membership plus a fake `m.direct` store. */
function fakeClient(opts: {
  joined?: Set<string>;
  direct?: Record<string, Record<string, string[]>>; // ownerMxid -> m.direct content
  onGetAccountData?: (userId: string, type: string) => Promise<Record<string, unknown> | null>;
} = {}): DescribeClient {
  const joined = opts.joined ?? new Set<string>();
  const direct = opts.direct ?? {};
  return {
    isJoined: async (userId, roomId) => joined.has(`${userId}|${roomId}`),
    getAccountData:
      opts.onGetAccountData ?? (async (userId) => (direct[userId] as Record<string, unknown>) ?? null),
  };
}

/** A `describeRooms` deps object with everything overridable. */
function describeDeps(overrides: Partial<DescribeDeps> = {}): DescribeDeps {
  return {
    domain: DOMAIN,
    rows: overrides.rows ?? (async () => [ROW]),
    client: overrides.client ?? fakeClient(),
    principalHandle: overrides.principalHandle ?? (async () => "writer-quill"),
    ownerMxidFor: overrides.ownerMxidFor ?? (async () => OWNER),
  };
}

describe("describeRooms — live membership and a live m.direct read, never a flag", () => {
  test("a room where nothing has happened yet is reported with all three steps outstanding", async () => {
    const rooms = await describeRooms(describeDeps());

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      roomId: ROW.roomId,
      oldUserId: OLD_USER,
      newUserId: NEW_USER,
      joinOutstanding: true,
      leaveOutstanding: false,
      directOutstanding: true,
    });
  });

  test("a room where the new user has joined but the old has not left is still reported — half-migrated", async () => {
    // The exact crash Task 9's review named: a run that died between join and
    // leave. Detected from membership, because nothing wrote a flag for it.
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`, `${OLD_USER}|${ROW.roomId}`]);

    const rooms = await describeRooms(describeDeps({ client: fakeClient({ joined }) }));

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ joinOutstanding: false, leaveOutstanding: true });
  });

  test("a room fully done — joined, left, and m.direct already naming the new user — is omitted", async () => {
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`]); // old is NOT in this set — it left
    const direct = { [OWNER]: { [NEW_USER]: [ROW.roomId] } };

    const rooms = await describeRooms(describeDeps({ client: fakeClient({ joined, direct }) }));

    expect(rooms).toEqual([]);
  });

  test("join and leave done but m.direct never confirmed is STILL reported — the refusal case", async () => {
    // The critical fix: a refused m.direct write no longer blocks `leave`, so
    // membership can finish moving while m.direct never gets fixed. That must
    // stay visible forever, not vanish once the coupling would have hidden it.
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`]); // old left, m.direct never written
    const rooms = await describeRooms(describeDeps({ client: fakeClient({ joined, direct: {} }) }));

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      joinOutstanding: false,
      leaveOutstanding: false,
      directOutstanding: true,
    });
  });

  test("no linked owner keeps the room visible even once join and leave are both done", async () => {
    // The bug named "Important": ownerMxid null must not make the room
    // silently disappear once membership finishes moving.
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`]);
    const rooms = await describeRooms(
      describeDeps({ client: fakeClient({ joined }), ownerMxidFor: async () => null })
    );

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ ownerMxid: null, directOutstanding: true });
  });

  test("a failure reading m.direct is reported as outstanding, not treated as fixed", async () => {
    const joined = new Set([`${NEW_USER}|${ROW.roomId}`]);
    const client = fakeClient({
      joined,
      onGetAccountData: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });

    const rooms = await describeRooms(describeDeps({ client }));

    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.directOutstanding).toBe(true);
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

const ROOM_STATUS_BASE = {
  roomId: "!r:id.agentpod.dev",
  stationKey: ROW.stationKey,
  nodeName: ROW.nodeName,
  handle: "writer-quill",
  oldUserId: OLD_USER,
  newUserId: NEW_USER,
  ownerMxid: OWNER,
  joinOutstanding: true,
  leaveOutstanding: false,
  directOutstanding: true,
};

describe("buildMigrationDeps — m.direct is read-modify-write, and never fatal", () => {
  function client(overrides: Partial<DirectClient> = {}, accountData: Record<string, unknown> = {}) {
    const state = { written: null as Record<string, unknown> | null };
    const c: DirectClient = {
      join: overrides.join ?? (async () => {}),
      leave: overrides.leave ?? (async () => {}),
      getAccountData:
        overrides.getAccountData ?? (async () => (Object.keys(accountData).length ? accountData : null)),
      setAccountData:
        overrides.setAccountData ??
        (async (_u, _t, content) => {
          state.written = content;
        }),
    };
    return { c, state };
  }

  test("every other DM in m.direct survives untouched", async () => {
    // The single most destructive thing available in this task: blindly
    // writing one entry would discard every other conversation the operator
    // has. This is the test that would catch it.
    const { c, state } = client(
      {},
      {
        [OLD_USER]: ["!r:id.agentpod.dev"],
        "@some-other-agent:id.agentpod.dev": ["!unrelated:id.agentpod.dev"],
      }
    );

    const { deps } = buildMigrationDeps([ROOM_STATUS_BASE], c);
    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(state.written).toEqual({
      "@some-other-agent:id.agentpod.dev": ["!unrelated:id.agentpod.dev"],
      [NEW_USER]: ["!r:id.agentpod.dev"],
    });
  });

  test("the old key survives if it still names another room", async () => {
    const { c, state } = client({}, { [OLD_USER]: ["!r:id.agentpod.dev", "!other-room:id.agentpod.dev"] });

    const { deps } = buildMigrationDeps([ROOM_STATUS_BASE], c);
    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(state.written).toEqual({
      [OLD_USER]: ["!other-room:id.agentpod.dev"],
      [NEW_USER]: ["!r:id.agentpod.dev"],
    });
  });

  test("a room with no linked owner is logged and left alone, not guessed at, and recorded as no-owner", async () => {
    const { c } = client();
    let setCalled = false;
    c.setAccountData = async () => {
      setCalled = true;
    };

    const { deps, directOutcomes } = buildMigrationDeps([{ ...ROOM_STATUS_BASE, ownerMxid: null }], c);
    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(setCalled).toBe(false);
    expect(directOutcomes.get("!r:id.agentpod.dev")).toEqual({ status: "no-owner" });
  });

  test("a refused write is caught, recorded as failed, and does not throw", async () => {
    // The critical fix. If this threw, migrateAgentMxids would never reach
    // `leave`, and the room would be stuck with both agents present forever.
    const { c } = client();
    c.setAccountData = async () => {
      throw new Error("M_FORBIDDEN: cannot act as another user's account data");
    };

    const { deps, directOutcomes } = buildMigrationDeps([ROOM_STATUS_BASE], c);

    await expect(deps.setDirect(NEW_USER, "!r:id.agentpod.dev")).resolves.toBeUndefined();
    expect(directOutcomes.get("!r:id.agentpod.dev")).toEqual({
      status: "failed",
      error: "M_FORBIDDEN: cannot act as another user's account data",
    });
  });

  test("a successful write is recorded as fixed", async () => {
    const { c } = client();
    const { deps, directOutcomes } = buildMigrationDeps([ROOM_STATUS_BASE], c);
    await deps.setDirect(NEW_USER, "!r:id.agentpod.dev");

    expect(directOutcomes.get("!r:id.agentpod.dev")).toEqual({ status: "fixed" });
  });
});

describe("runMigration — a refused m.direct still lets leave run, and failures isolate per room", () => {
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
    expect(result.results).toEqual([]);
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
      // setAccountData is called as the OWNER, not the agent — m.direct is
      // the human's own account data, not the agent's.
      `direct ${OWNER}`,
      `leave ${OLD_USER} ${ROW.roomId}`,
    ]);
    expect(result.results).toEqual([
      { roomId: ROW.roomId, stationKey: ROW.stationKey, direct: { status: "fixed" } },
    ]);
  });

  test("a refused m.direct write does not stop leave from running, and is reported per room", async () => {
    const acts: string[] = [];
    const c: DirectClient = {
      join: async (u, r) => { acts.push(`join ${u} ${r}`); },
      leave: async (u, r) => { acts.push(`leave ${u} ${r}`); },
      getAccountData: async () => null,
      setAccountData: async () => {
        throw new Error("M_FORBIDDEN");
      },
    };

    const result = await runMigration(describeDeps(), c, { apply: true });

    // leave still ran, and the room still counts as migrated: membership
    // moved correctly even though the DM flag could not be fixed.
    expect(acts).toEqual([`join ${NEW_USER} ${ROW.roomId}`, `leave ${OLD_USER} ${ROW.roomId}`]);
    expect(result.migrated).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.results).toEqual([
      { roomId: ROW.roomId, stationKey: ROW.stationKey, direct: { status: "failed", error: "M_FORBIDDEN" } },
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
    // The failed room's result carries the error and no direct outcome —
    // setDirect never ran because join threw first.
    expect(result.results.find((r) => r.roomId === ROW.roomId)).toEqual({
      roomId: ROW.roomId,
      stationKey: ROW.stationKey,
      error: "rate limited",
      direct: null,
    });
  });
});

describe("formatReport — what an operator reads before deciding", () => {
  test("a dry run names the room, both addresses, and the outstanding steps, and says nothing changed", () => {
    const report = formatReport({
      applied: false,
      migrated: 0,
      skipped: 0,
      failures: [],
      results: [],
      rooms: [ROOM_STATUS_BASE],
    });

    expect(report).toContain("DRY RUN");
    expect(report).toContain("Nothing has been changed");
    expect(report).toContain(ROW.roomId);
    expect(report).toContain(OLD_USER);
    expect(report).toContain(NEW_USER);
    expect(report).toContain("join, m.direct");
  });

  test("a room whose m.direct write was refused shows that plainly in an apply report", () => {
    const report = formatReport({
      applied: true,
      migrated: 1,
      skipped: 0,
      failures: [],
      results: [
        {
          roomId: ROW.roomId,
          stationKey: ROW.stationKey,
          direct: { status: "failed", error: "M_FORBIDDEN" },
        },
      ],
      rooms: [{ ...ROOM_STATUS_BASE, joinOutstanding: false, leaveOutstanding: false }],
    });

    expect(report).toContain("membership updated");
    expect(report).toContain("m.direct: skipped — M_FORBIDDEN");
  });

  test("no outstanding rooms is reported plainly", () => {
    expect(
      formatReport({ applied: false, migrated: 0, skipped: 0, failures: [], results: [], rooms: [] })
    ).toContain("No rooms need migration");
  });
});
