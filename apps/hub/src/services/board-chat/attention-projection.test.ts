process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { ATTENTION_V2_SUITE_TYPE, type AttentionPendingDelivery } from "@superjackfruitlabs/treaty-matrix-events";
import {
  claimAttentionOutcome,
  postedAttentionAwaitingOutcome,
  projectAttention,
  recordedAttention,
  type AttentionProjectionDeps,
} from "./attention-projection";

/**
 * Posting a waiting card into its board room exactly once per wait — the claim taken before the
 * send, given back when the send fails — and the record its answer is judged against.
 */
const ROOM = "!board-room:id.example";
const SPEAKER = "@agent_superpipeline:id.example";
const RUN = crypto.randomUUID().slice(0, 8);
const BOARD = `brd_test_${RUN}`;
let n = 0;
let events = 0;

const INPUT = { kind: "text", label: "What should the next attempt do?", required: true, maxLength: 2730 };

function waiting(over: Partial<AttentionPendingDelivery> = {}): AttentionPendingDelivery {
  return {
    event: "attention.pending",
    boardId: BOARD,
    boardName: "Release board",
    cardId: `crd_${RUN}`,
    cardTitle: "Ship the release",
    stageKey: "build",
    stageName: "Build",
    waitId: `wait_${RUN}${String(++n).padStart(8, "0")}`,
    reason: "blocked",
    detail: "the staging database is down",
    summary: null,
    failureCount: null,
    earlierStages: [{ key: "plan", name: "Plan" }],
    options: [
      { id: "resume_here", label: "Resume here", meaning: "approve", needsComment: false, input: INPUT },
      { id: "resume_at:plan", label: "Resume at Plan", meaning: "choose", needsComment: false, input: INPUT },
      { id: "archive", label: "Archive", meaning: "reject", needsComment: false },
    ],
    ts: "2026-11-08T10:00:00.000Z",
    ...over,
  };
}

function rig(over: Partial<AttentionProjectionDeps> = {}) {
  const sent: Array<{ roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const posted: string[] = [];
  const deps: AttentionProjectionDeps = {
    boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
    sendText: async (_user, roomId, body, extra) => {
      sent.push({ roomId, body, extra });
      return `$attention-${RUN}-${++events}`;
    },
    onAttentionPosted: async (d) => {
      posted.push(d.waitId);
    },
    ...over,
  };
  return { deps, sent, posted };
}

const key = (d: AttentionPendingDelivery) => ({ boardId: d.boardId, cardId: d.cardId, waitId: d.waitId });

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_attention_events WHERE board_id = ${BOARD}`;
});

describe("a waiting card is posted into its board's room", () => {
  test("posts one attention.v2 message, records what it offered, and tells the fleet card", async () => {
    const d = waiting();
    const { deps, sent, posted } = rig();
    const out = await projectAttention(BOOTSTRAP_TENANT_ID, d, deps);

    expect(out.status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.extra).toMatchObject({ suite_event_type: ATTENTION_V2_SUITE_TYPE, wait_id: d.waitId, card_id: d.cardId });
    expect(await recordedAttention(key(d))).toMatchObject({
      ...key(d),
      roomId: ROOM,
      eventId: out.status === "posted" ? out.eventId : "",
      options: [{ id: "resume_here" }, { id: "resume_at:plan" }, { id: "archive" }],
    });
    expect(posted).toEqual([d.waitId]);
  });

  test("a redelivered wait is posted once; the same card parked again is a new card", async () => {
    const d = waiting();
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, d, rig().deps)).status).toBe("posted");
    const second = rig();
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, d, second.deps)).status).toBe("already");
    expect(second.sent).toHaveLength(0);
    const again = rig();
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, waiting({ cardId: d.cardId }), again.deps)).status).toBe("posted");
    expect(again.sent).toHaveLength(1);
  });

  test("a send that throws gives the claim back, and re-throws", async () => {
    const d = waiting();
    const { deps, posted } = rig({
      sendText: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });
    await expect(projectAttention(BOOTSTRAP_TENANT_ID, d, deps)).rejects.toThrow("M_FORBIDDEN");
    expect(await rawSql`SELECT 1 FROM matrix_attention_events WHERE wait_id = ${d.waitId}`).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  test("a refused send gives the claim back", async () => {
    const d = waiting();
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, d, rig({ sendText: async () => null }).deps)).status).toBe("not-accepted");
    expect(await rawSql`SELECT 1 FROM matrix_attention_events WHERE wait_id = ${d.waitId}`).toHaveLength(0);
  });

  test("two waits whose ids contain ':' never share a placeholder while both are being sent", async () => {
    const first = waiting({ cardId: `x:${RUN}`, waitId: "w" });
    const second = waiting({ boardId: BOARD, cardId: "x", waitId: `${RUN}:w` });
    let inner: string | undefined;
    const { deps } = rig({
      sendText: async () => {
        // The second wait is projected while the first is still `pending:`.
        inner ??= (await projectAttention(BOOTSTRAP_TENANT_ID, second, rig().deps)).status;
        return `$attention-${RUN}-${++events}`;
      },
    });
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, first, deps)).status).toBe("posted");
    expect(inner).toBe("posted");
  });

  test("held, with no row, until a human has joined the room", async () => {
    const d = waiting();
    const { deps, sent } = rig({ humanJoined: async () => false });
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("awaiting-join");
    expect(sent).toHaveLength(0);
    expect(await recordedAttention(key(d))).toBeNull();
  });

  test("no board room: nothing posted, nothing recorded", async () => {
    const d = waiting();
    expect((await projectAttention(BOOTSTRAP_TENANT_ID, d, rig({ boardRoom: async () => null }).deps)).status).toBe("no-room");
    expect(await recordedAttention(key(d))).toBeNull();
  });

  test("the receipt is claimed once, and a settled card is no longer awaiting an outcome", async () => {
    const d = waiting();
    await projectAttention(BOOTSTRAP_TENANT_ID, d, rig().deps);
    expect(await postedAttentionAwaitingOutcome(BOARD)).toEqual([key(d)]);
    expect(await claimAttentionOutcome(key(d))).toBe(true);
    expect(await claimAttentionOutcome(key(d))).toBe(false);
    expect(await postedAttentionAwaitingOutcome(BOARD)).toEqual([]);
  });
});
