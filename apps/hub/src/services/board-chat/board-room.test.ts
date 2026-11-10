process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../db/drizzle";
import { matrixBoardRooms } from "../../db/schema/board-rooms";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import {
  boardRoomAlias,
  boardSpeakerMxid,
  ensureBoardRoom,
  type BoardRoomDeps,
} from "./board-room";

/**
 * The room a board's gates close in.
 *
 * What is asserted hardest is the ORDER, because order is what makes this safe to
 * run twice: a room recorded before it is encrypted is a room gates go into in the
 * clear, and a room created but not recorded is a second room on the next call —
 * two rooms for one board being the failure that retrying cannot repair.
 */
const DOMAIN = "id.agentpod.dev";
const HUMAN = `@rakesh:${DOMAIN}`;
const RUN = crypto.randomUUID().slice(0, 8);

function rig(over: Partial<BoardRoomDeps> = {}) {
  const calls: string[] = [];
  const invited: string[] = [];
  const created: Array<{ name: string; topic: string }> = [];
  const renamed: string[] = [];
  const deps: BoardRoomDeps = {
    domain: DOMAIN,
    ensureUser: async (lp) => void calls.push(`ensureUser:${lp}`),
    ensureRoom: async (alias, opts) => {
      calls.push(`ensureRoom:${alias}`);
      created.push({ name: opts.name, topic: opts.topic });
      return `!room-${alias}:${DOMAIN}`;
    },
    invite: async (_as, _room, who) => {
      calls.push("invite");
      invited.push(who);
    },
    enableEncryption: async () => {
      calls.push("encrypt");
      return true;
    },
    setName: async (_as, _room, name) => {
      calls.push(`setName:${name}`);
      renamed.push(name);
      return true;
    },
    humansFor: async () => [HUMAN],
    ...over,
  };
  return { deps, calls, invited, created, renamed };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_board_rooms WHERE board_id LIKE ${"brd_test_" + RUN + "%"}`;
});

describe("a board's room", () => {
  test("is created, encrypted, recorded, and its humans invited", async () => {
    const boardId = `brd_test_${RUN}_a`;
    const { deps, calls, invited } = rig();

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).not.toBeNull();
    expect(room!.created).toBe(true);
    expect(room!.speakerMxid).toBe(boardSpeakerMxid(DOMAIN));
    expect(invited).toContain(HUMAN);

    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.roomId).toBe(room!.roomId);
    expect(row!.speakerMxid).toBe(boardSpeakerMxid(DOMAIN));
    expect(row!.alias).toBe(boardRoomAlias(boardId));
  });

  test("encryption is turned on BEFORE the room is recorded", async () => {
    // A room written down as the board's while still plaintext is a room gates
    // would be posted into in the clear.
    const boardId = `brd_test_${RUN}_b`;
    const { deps, calls } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);
    expect(calls.indexOf("encrypt")).toBeGreaterThan(calls.findIndex((c) => c.startsWith("ensureRoom:")));
  });

  test("a room that cannot be encrypted is NOT recorded", async () => {
    // Better to make it again next time than to remember a room gates cannot
    // safely use.
    const boardId = `brd_test_${RUN}_c`;
    const { deps } = rig({ enableEncryption: async () => false });

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).toBeNull();
    const rows = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(rows).toHaveLength(0);
  });

  test("asking twice returns the same room rather than making a second", async () => {
    // Two rooms for one board is the failure retrying cannot repair.
    const boardId = `brd_test_${RUN}_d`;
    const first = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);
    const second = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);

    expect(second!.roomId).toBe(first!.roomId);
    expect(second!.created).toBe(false);
  });

  test("a human added later is invited to the room that already exists", async () => {
    const boardId = `brd_test_${RUN}_e`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);

    const late = `@second:${DOMAIN}`;
    const { deps, invited } = rig({ humansFor: async () => [HUMAN, late] });
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(invited).toContain(late);
  });

  test("one person who cannot be invited does not cost everybody else the room", async () => {
    const boardId = `brd_test_${RUN}_f`;
    const good = `@good:${DOMAIN}`;
    const { deps, invited } = rig({
      humansFor: async () => [`@bad:${DOMAIN}`, good],
      invite: async (_as, _room, who) => {
        if (who.startsWith("@bad")) throw new Error("M_FORBIDDEN");
        invitedLocal.push(who);
      },
    });
    const invitedLocal: string[] = [];

    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(room).not.toBeNull();
    expect(invitedLocal).toContain(good);
  });

  test("the alias is safe for a board id with awkward characters", async () => {
    // It becomes a Matrix alias localpart, and the appservice owns `#agentpod_.*`.
    expect(boardRoomAlias("brd_7c1f")).toBe("agentpod_board_brd_7c1f");
    expect(boardRoomAlias("brd/../etc")).toBe("agentpod_board_brd____etc");
  });
});

/**
 * A board's room is named after the board.
 *
 * It was named after the PRODUCT — the literal string `superpipeline`, hardcoded —
 * because this service had no way to learn what a board was called and cannot ask: the
 * board's only metadata route resolves a user session, which is the same wall that
 * makes `humansFor` an injected dependency rather than a fetch. So an operator with
 * four boards saw four rooms with one name, and the topic showed a raw `brd_…` id.
 *
 * The board now sends `boardName` on its pushes. What is asserted hardest here is the
 * FALLBACK, because that is the half that can do damage: a service newer than the board
 * it talks to receives no name, and must leave a correctly-named room alone rather than
 * rename it to nothing.
 */
describe("a board's room is named after its board", () => {
  test("is created with the board's name, and a topic that reads", async () => {
    const boardId = `brd_test_${RUN}_name`;
    const { deps, created } = rig();

    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps, { boardName: "Client Quality" });

    expect(created[0]!.name).toBe("Client Quality");
    expect(created[0]!.topic).toContain("Client Quality");
    // The id is what a person cannot read, and the whole reason this changed.
    expect(created[0]!.name).not.toContain(boardId);
  });

  test("falls back to the id when the board sent no name", async () => {
    const boardId = `brd_test_${RUN}_noname`;
    const { deps, created } = rig();

    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(created[0]!.name).toBe(boardId);
  });

  test("records the name it set, so the next pass can compare", async () => {
    const boardId = `brd_test_${RUN}_record`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps, { boardName: "Client Quality" });

    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.name).toBe("Client Quality");
  });

  test("renames a room whose board was renamed", async () => {
    const boardId = `brd_test_${RUN}_rename`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps, { boardName: "Old Name" });

    const { deps, renamed } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps, { boardName: "New Name" });

    expect(renamed).toEqual(["New Name"]);
    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.name).toBe("New Name");
  });

  test("backfills a room recorded before this service knew any name", async () => {
    // Every room that existed when this shipped has a null `name`, and is named
    // `superpipeline` on the homeserver. This is the migration: there isn't one.
    const boardId = `brd_test_${RUN}_backfill`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps);
    await db
      .update(matrixBoardRooms)
      .set({ name: null })
      .where(eq(matrixBoardRooms.boardId, boardId));

    const { deps, renamed } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps, { boardName: "Client Quality" });

    expect(renamed).toEqual(["Client Quality"]);
  });

  test("does not rename a room whose name has not changed", async () => {
    // Every gate on every board would otherwise write a state event that says
    // nothing, which is noise in the room's timeline and a request per gate.
    const boardId = `brd_test_${RUN}_same`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps, { boardName: "Client Quality" });

    const { deps, renamed } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps, { boardName: "Client Quality" });

    expect(renamed).toEqual([]);
  });

  test("does NOT rename an already-named room when the board sends no name", async () => {
    // The dangerous half. A service newer than its board receives no name; falling back
    // to the id here would rename a perfectly good room to `brd_…`, which is exactly
    // the unreadable state this change exists to remove.
    const boardId = `brd_test_${RUN}_keep`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps, { boardName: "Client Quality" });

    const { deps, renamed } = rig();
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps);

    expect(renamed).toEqual([]);
    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.name).toBe("Client Quality");
  });

  test("a rename that fails leaves the room usable", async () => {
    // A room that cannot be renamed is still a room gates close in. This is not the
    // encryption case, where refusing to record is the safe answer — a wrong NAME
    // cannot leak anything.
    const boardId = `brd_test_${RUN}_renamefail`;
    await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, rig().deps, { boardName: "Old Name" });

    const { deps } = rig({ setName: async () => false });
    const room = await ensureBoardRoom(boardId, BOOTSTRAP_TENANT_ID, deps, { boardName: "New Name" });

    expect(room).not.toBeNull();
    expect(room!.roomId).toBeTruthy();
    // And the recorded name stays what the homeserver actually has, so the next pass
    // tries again rather than believing a rename that never landed.
    const [row] = await db
      .select()
      .from(matrixBoardRooms)
      .where(eq(matrixBoardRooms.boardId, boardId));
    expect(row!.name).toBe("Old Name");
  });
});
