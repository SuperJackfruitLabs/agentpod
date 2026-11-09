/**
 * A gate may be decided by checks (charter: "A gate may be decided by checks" §4, §5, §7), against
 * the database: a failed or overridden check becomes one line in that tenant's board room, a
 * redelivered push posts nothing twice, overdue checks are reminded alone and escalated with a
 * checks.waiting card the notice replies to, an admin who joins later gets that card posted again,
 * and an override from chat must reference the card's current copy.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { matrixBoardRooms } from "../../src/db/schema/board-rooms";
import { matrixCheckNotices, matrixChecksWaiting, matrixDecisionNotices, matrixEscalationInvites } from "../../src/db/schema/matrix";
import { BOOTSTRAP_TENANT_ID, tenants } from "../../src/db/schema/tenants";
import type { CheckFailedDelivery, CheckOverriddenDelivery, DecisionTimeoutDelivery } from "../../src/services/bridge";
import { handleCheckFailed, handleCheckOverridden, type CheckNoticeDeps } from "../../src/services/matrix-as/check-notices";
import { handleCheckOverride } from "../../src/services/matrix-as/check-override";
import { recordedChecksCard } from "../../src/services/matrix-as/checks-waiting";
import { CHECKS_WAITING_TYPE, CHECK_FAILED_TYPE, CHECK_OVERRIDDEN_TYPE, CHECK_OVERRIDE_V2_SUITE_TYPE } from "../../src/services/matrix-as/checks-wire";
import { handleDecisionTimeout, repostEscalationsOnJoin, type DecisionNoticeDeps } from "../../src/services/matrix-as/decision-notices";
import { DECISION_ESCALATED_SUITE_TYPE, DECISION_REMINDED_SUITE_TYPE } from "../../src/services/matrix-as/decision-timeout-wire";
import { MOVED_BELOW_TEXT } from "../../src/services/matrix-as/decision-repost";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const BOARD = "brd_checks0000000001";
const OTHER_BOARD = "brd_checks0000000002";
const ROOM = "!checksroom:test";
const SPEAKER = "@agent_superpipeline:test";
const CARD = "crd_checks01";
const ARRIVAL = "arr_checks01";
const ADMIN = "@admin:test";
const OTHER_TENANT = "fleet_checks_other";
const BOARDS = [BOARD, OTHER_BOARD];

// An empty title, as a board may send: the notices fall back to what this hub recorded.
const failed = (over: Partial<CheckFailedDelivery> = {}): CheckFailedDelivery => ({
  event: "check.failed",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "",
  arrivalId: ARRIVAL,
  stageKey: "review",
  check: { name: "build", provider: "ci", status: "failed", detail: "lint: failure", url: "https://forge.example/runs/413" },
  returnedTo: "build",
  ...over,
});

const overridden = (over: Partial<CheckOverriddenDelivery> = {}): CheckOverriddenDelivery => ({
  event: "check.overridden",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "",
  arrivalId: ARRIVAL,
  stageKey: "review",
  check: { name: "quality", provider: "verdict", status: "overridden" },
  by: "prn_rakesh",
  comment: "the grader is down",
  at: "2026-11-09T12:10:00.000Z",
  ...over,
});

const escalated = (over: Partial<DecisionTimeoutDelivery> = {}): DecisionTimeoutDelivery => ({
  event: "decision.escalated",
  boardId: BOARD,
  cardId: CARD,
  cardTitle: "Ship the release",
  stageKey: "review",
  stageName: "Review",
  decisionKind: "checks",
  decisionId: ARRIVAL,
  waitingSince: "2026-11-09T09:00:00.000Z",
  escalatedAt: "2026-11-09T12:00:00.000Z",
  ts: "2026-11-09T12:00:00.000Z",
  ...over,
});
const reminded = (over: Partial<DecisionTimeoutDelivery> = {}): DecisionTimeoutDelivery => ({
  ...escalated(over),
  event: "decision.reminded",
  escalatedAt: undefined,
  remindedAt: "2026-11-09T10:00:00.000Z",
  ...over,
});

const READ = {
  stageKey: "review",
  status: "open",
  checks: [
    { name: "build", provider: "ci", status: "passed", url: "https://forge.example/runs/412", updatedAt: "2026-11-09T09:01:00.000Z" },
    { name: "quality", provider: "verdict", status: "pending", detail: "no verdict yet", updatedAt: "2026-11-09T09:00:00.000Z" },
  ],
};

function rig(over: Partial<CheckNoticeDeps & DecisionNoticeDeps> = {}) {
  const texts: Array<{ userId: string; roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const events: Array<{ type: string; content: Record<string, unknown> }> = [];
  const invited: string[] = [];
  const deps: CheckNoticeDeps & DecisionNoticeDeps = {
    boardBaseUrl: "https://board.test",
    sendText: async (userId, roomId, body, extra) => {
      texts.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
      return `$text${texts.length}`;
    },
    sendCustomEvent: async (_u, _r, type, content) => {
      events.push({ type, content });
      return `$event${events.length}`;
    },
    displayNameFor: async (id) => (id === "prn_rakesh" ? "rakesh" : null),
    tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID],
    invite: async (_as, _room, who) => {
      invited.push(who);
    },
    workspaceAdmins: async () => [ADMIN],
    checksForCard: async () => READ,
    ...over,
  };
  return { deps, texts, events, invited };
}

async function clean() {
  await db.delete(matrixCheckNotices).where(inArray(matrixCheckNotices.boardId, BOARDS));
  await db.delete(matrixChecksWaiting).where(inArray(matrixChecksWaiting.boardId, BOARDS));
  await db.delete(matrixDecisionNotices).where(inArray(matrixDecisionNotices.boardId, BOARDS));
  await db.delete(matrixEscalationInvites).where(inArray(matrixEscalationInvites.boardId, BOARDS));
  await db.delete(matrixBoardRooms).where(inArray(matrixBoardRooms.boardId, BOARDS));
}

beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(tenants).values({ id: OTHER_TENANT, name: "checks other" }).onConflictDoNothing();
});

beforeEach(async () => {
  await clean();
  await db.insert(matrixBoardRooms).values({ boardId: BOARD, roomId: ROOM, tenantId: BOOTSTRAP_TENANT_ID, speakerMxid: SPEAKER, alias: "agentpod_board_checks" });
});

afterAll(async () => {
  await clean();
  await db.delete(tenants).where(eq(tenants.id, OTHER_TENANT));
});

/** A checks.waiting card this hub posted for the card, as an escalation leaves it. */
async function waitingCard(over: Partial<typeof matrixChecksWaiting.$inferInsert> = {}) {
  await db.insert(matrixChecksWaiting).values({
    boardId: BOARD,
    decisionId: ARRIVAL,
    tenantId: BOOTSTRAP_TENANT_ID,
    cardId: CARD,
    cardTitle: "Ship the release",
    stageKey: "review",
    roomId: ROOM,
    eventId: "$waiting",
    ...over,
  });
}

describe("a failed check", () => {
  test("is one standalone line in the board's room, and one structured event, when nothing about these checks was posted", async () => {
    const { deps, texts, events } = rig();
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "sent" });
    expect(texts).toEqual([
      {
        userId: SPEAKER,
        roomId: ROOM,
        body: "CI check “build” failed — returned for changes. [Open the result](https://forge.example/runs/413)",
      },
    ]);
    expect(events).toEqual([
      {
        type: CHECK_FAILED_TYPE,
        content: {
          suite_event_type: CHECK_FAILED_TYPE,
          schema_version: 1,
          board_id: BOARD,
          card_id: CARD,
          stage_key: "review",
          check: { name: "build", provider: "ci", status: "failed", detail: "lint: failure", url: "https://forge.example/runs/413" },
          returned_to: "build",
        },
      },
    ]);
    const [row] = await db.select().from(matrixCheckNotices).where(eq(matrixCheckNotices.boardId, BOARD));
    expect(row).toMatchObject({ cardId: CARD, notice: "failed", checkName: "build", tenantId: BOOTSTRAP_TENANT_ID, roomId: ROOM, eventId: "$text1" });
  });

  test("names the card when a reminder of it already did", async () => {
    const { deps, texts } = rig();
    await handleDecisionTimeout(reminded(), deps);
    await handleCheckFailed(failed(), deps);
    expect(texts[1]?.body.startsWith("CI check “build” failed on “Ship the release” — returned for changes.")).toBe(true);
  });

  test("a redelivered push posts nothing twice", async () => {
    const { deps, texts, events } = rig();
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "sent" });
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("another check on the arrival is its own notice; the same check, however worded, is not", async () => {
    const { deps, texts } = rig();
    await handleCheckFailed(failed(), deps);
    expect(await handleCheckFailed(failed({ check: { name: "lint", provider: "ci", status: "failed" } }), deps)).toEqual({ status: "sent" });
    expect(await handleCheckFailed(failed({ check: { name: "build", provider: "ci", status: "failed", detail: "test: failure" } }), deps)).toEqual({
      status: "duplicate",
    });
    expect(texts).toHaveLength(2);
  });

  test("the same failure on the card's next arrival is said again; on the same arrival it is not", async () => {
    const { deps, texts } = rig();
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "sent" });
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "duplicate" });
    expect(await handleCheckFailed(failed({ arrivalId: "arr_checks02" }), deps)).toEqual({ status: "sent" });
    expect(await handleCheckFailed(failed({ arrivalId: "arr_checks02" }), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(2);
    expect(texts[1]?.body).toBe(texts[0]?.body);
    const rows = await db.select().from(matrixCheckNotices).where(eq(matrixCheckNotices.boardId, BOARD));
    expect(rows.map((r) => r.arrivalId).toSorted()).toEqual([ARRIVAL, "arr_checks02"]);
  });

  test("a claim still being sent is never taken over, however old", async () => {
    const { deps, texts } = rig();
    await handleCheckFailed(failed(), deps);
    // As if the first delivery were still sending: no event id recorded yet, and long ago.
    await db
      .update(matrixCheckNotices)
      .set({ eventId: null, createdAt: new Date(Date.now() - 24 * 3600_000) })
      .where(eq(matrixCheckNotices.boardId, BOARD));
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
  });

  test("names the card from the push, before anything this hub recorded", async () => {
    await waitingCard({ cardTitle: "An older title" });
    const { deps, texts, events } = rig();
    await handleCheckFailed(failed({ cardTitle: " Ship it now " }), deps);
    expect(texts[0]?.body.startsWith("CI check “build” failed on “Ship it now” — returned for changes.")).toBe(true);
    expect(events[0]?.content.card_title).toBe("Ship it now");
  });

  test("a send that fails gives the claim back, so the board's retry posts it", async () => {
    const failing = rig({
      sendText: async () => {
        throw new Error("homeserver down");
      },
    });
    await expect(handleCheckFailed(failed(), failing.deps)).rejects.toThrow("homeserver down");
    const { deps, texts } = rig();
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "sent" });
    expect(texts).toHaveLength(1);
  });

  test("replies to the open checks.waiting card for its card and stage, and closes it when the card went back", async () => {
    await waitingCard();
    const { deps, texts, events } = rig();
    expect(await handleCheckFailed(failed(), deps)).toEqual({ status: "sent" });
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$waiting" } });
    expect(texts[0]?.body.startsWith("CI check “build” failed on “Ship the release”")).toBe(true);
    expect(events[0]?.content["m.relates_to"]).toEqual({ rel_type: "m.reference", event_id: "$waiting" });
    const [row] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
    expect(row?.closedAt).not.toBeNull();
    // Closed: the next failure on this card stands alone.
    await handleCheckFailed(failed({ check: { name: "lint", provider: "ci", status: "failed" } }), deps);
    expect(texts[1]?.extra).toBeUndefined();
  });

  test("a failure that could not send the card back leaves the checks.waiting card open", async () => {
    await waitingCard();
    const { deps } = rig();
    await handleCheckFailed(failed({ returnedTo: null }), deps);
    const [row] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
    expect(row?.closedAt).toBeNull();
  });

  test("a checks.waiting card for another stage, room or tenant is not replied to", async () => {
    for (const over of [{ stageKey: "publish" }, { roomId: "!elsewhere:test" }, { tenantId: OTHER_TENANT }]) {
      await db.delete(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
      await db.delete(matrixCheckNotices).where(eq(matrixCheckNotices.boardId, BOARD));
      await waitingCard(over);
      const { deps, texts } = rig();
      await handleCheckFailed(failed(), deps);
      expect(texts[0]?.extra, JSON.stringify(over)).toBeUndefined();
    }
  });
});

describe("an overridden check", () => {
  test("is one line naming who and why, replying to the checks.waiting card, with their handle, never their id", async () => {
    await waitingCard();
    const { deps, texts, events } = rig();
    expect(await handleCheckOverridden(overridden(), deps)).toEqual({ status: "sent" });
    expect(texts[0]?.body).toBe("Verdict check “quality” on “Ship the release” overridden by rakesh: the grader is down");
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$waiting" } });
    expect(events[0]).toEqual({
      type: CHECK_OVERRIDDEN_TYPE,
      content: {
        suite_event_type: CHECK_OVERRIDDEN_TYPE,
        schema_version: 1,
        board_id: BOARD,
        card_id: CARD,
        card_title: "Ship the release",
        stage_key: "review",
        check: { name: "quality", provider: "verdict", status: "overridden" },
        overridden_by: "rakesh",
        comment: "the grader is down",
        at: "2026-11-09T12:10:00.000Z",
        "m.relates_to": { rel_type: "m.reference", event_id: "$waiting" },
      },
    });
    expect(JSON.stringify(events)).not.toContain("prn_rakesh");
    // An override does not close the card: the rest of its checks may still be pending.
    const [row] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
    expect(row?.closedAt).toBeNull();
  });

  test("a redelivered push posts nothing twice", async () => {
    const { deps, texts } = rig();
    expect(await handleCheckOverridden(overridden(), deps)).toEqual({ status: "sent" });
    expect(await handleCheckOverridden(overridden(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(1);
  });
});

describe("nothing is said", () => {
  test("for a board known to no tenant, or to several", async () => {
    const none = rig({ tenantsForBoard: async () => [] });
    expect(await handleCheckFailed(failed(), none.deps)).toEqual({ status: "unknown-board" });
    const two = rig({ tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID, OTHER_TENANT] });
    expect(await handleCheckOverridden(overridden(), two.deps)).toEqual({ status: "ambiguous-board" });
    expect(none.texts).toHaveLength(0);
    expect(two.texts).toHaveLength(0);
  });

  test("for a board with no room here, or whose room is another tenant's", async () => {
    const noRoom = rig();
    expect(await handleCheckFailed(failed({ boardId: OTHER_BOARD }), noRoom.deps)).toEqual({ status: "no-room" });
    const other = rig({ tenantsForBoard: async () => [OTHER_TENANT] });
    expect(await handleCheckOverridden(overridden(), other.deps)).toEqual({ status: "no-room" });
    expect(noRoom.texts).toHaveLength(0);
    expect(other.texts).toHaveLength(0);
    expect(await db.select().from(matrixCheckNotices).where(inArray(matrixCheckNotices.boardId, BOARDS))).toHaveLength(0);
  });

  test("for a push that is not well formed", async () => {
    const { deps, texts } = rig();
    expect(await handleCheckFailed(failed({ returnedTo: "" }), deps)).toEqual({ status: "malformed" });
    expect(await handleCheckOverridden(overridden({ comment: " " }), deps)).toEqual({ status: "malformed" });
    expect(texts).toHaveLength(0);
  });
});

describe("overdue checks", () => {
  test("are reminded with a line that stands alone", async () => {
    const { deps, texts } = rig();
    expect(await handleDecisionTimeout(reminded(), deps)).toEqual({ status: "sent", invited: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]?.body).toBe('Still waiting: "Ship the release" has waited 1 h for its checks.');
    expect(texts[0]?.extra?.suite_event_type).toBe(DECISION_REMINDED_SUITE_TYPE);
    expect(texts[0]?.extra).not.toHaveProperty("m.relates_to");
    const [row] = await db.select().from(matrixDecisionNotices).where(eq(matrixDecisionNotices.boardId, BOARD));
    expect(row).toMatchObject({ decisionKind: "checks", decisionId: ARRIVAL, notice: "reminded", cardEventId: null, eventId: "$text1" });
  });

  test("are escalated: the admins invited, a checks.waiting card listing them, and the notice in reply to it", async () => {
    const { deps, texts, invited } = rig();
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "sent", invited: 1 });
    expect(invited).toEqual([ADMIN]);
    expect(texts).toHaveLength(2);
    const card = texts[0];
    expect(card?.body).toBe(
      "Checks overdue on “Ship the release” at Review: build (CI) ✓, quality (verdict) pending. A workspace owner or admin may override a check, with a comment. [Open the card](https://board.test/b/brd_checks0000000001/c/crd_checks01)",
    );
    expect(card?.extra).toMatchObject({
      msgtype: "m.text",
      suite_event_type: CHECKS_WAITING_TYPE,
      schema_version: 1,
      board_id: BOARD,
      card_id: CARD,
      card_title: "Ship the release",
      stage_key: "review",
      checks: [
        { name: "build", provider: "ci", status: "passed", url: "https://forge.example/runs/412" },
        { name: "quality", provider: "verdict", status: "pending" },
      ],
    });
    expect(texts[1]?.extra?.suite_event_type).toBe(DECISION_ESCALATED_SUITE_TYPE);
    expect(texts[1]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$text1" } });
    const [waiting] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
    expect(waiting).toMatchObject({ decisionId: ARRIVAL, cardId: CARD, stageKey: "review", roomId: ROOM, eventId: "$text1", closedAt: null });
    const [notice] = await db.select().from(matrixDecisionNotices).where(eq(matrixDecisionNotices.boardId, BOARD));
    expect(notice).toMatchObject({ notice: "escalated", cardEventId: "$text1", eventId: "$text2" });
  });

  test("a redelivered escalation posts nothing twice", async () => {
    const { deps, texts } = rig();
    await handleDecisionTimeout(escalated(), deps);
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "duplicate" });
    expect(texts).toHaveLength(2);
  });

  test("an escalation whose notice failed reuses the card on the board's retry", async () => {
    let calls = 0;
    const flaky = rig({
      sendText: async () => {
        calls++;
        if (calls === 2) throw new Error("homeserver down");
        return `$flaky${calls}`;
      },
    });
    await expect(handleDecisionTimeout(escalated(), flaky.deps)).rejects.toThrow("homeserver down");
    const { deps, texts } = rig();
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "sent", invited: 0 });
    expect(texts).toHaveLength(1);
    expect(texts[0]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$flaky1" } });
  });

  test("checks that are over, or at another stage, escalate with the notice alone", async () => {
    for (const read of [null, { ...READ, status: "passed" }, { ...READ, stageKey: "publish" }, { ...READ, checks: [{ name: "a/b", provider: "ci", status: "pending" }] }]) {
      await clean();
      await db.insert(matrixBoardRooms).values({ boardId: BOARD, roomId: ROOM, tenantId: BOOTSTRAP_TENANT_ID, speakerMxid: SPEAKER, alias: "agentpod_board_checks" });
      const { deps, texts } = rig({ checksForCard: async () => read });
      expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "sent", invited: 1 });
      expect(texts, JSON.stringify(read)).toHaveLength(1);
      expect(texts[0]?.extra, JSON.stringify(read)).not.toHaveProperty("m.relates_to");
      expect(await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD))).toHaveLength(0);
    }
  });

  test("a board that cannot be read is retried before anything is claimed", async () => {
    const { deps, texts } = rig({
      checksForCard: async () => {
        throw new Error("board down");
      },
    });
    await expect(handleDecisionTimeout(escalated(), deps)).rejects.toThrow("board down");
    expect(texts).toHaveLength(0);
    expect(await db.select().from(matrixDecisionNotices).where(eq(matrixDecisionNotices.boardId, BOARD))).toHaveLength(0);
  });

  test("a board known to several tenants is neither reminded nor escalated", async () => {
    const { deps, texts } = rig({ tenantsForBoard: async () => [BOOTSTRAP_TENANT_ID, OTHER_TENANT] });
    expect(await handleDecisionTimeout(escalated(), deps)).toEqual({ status: "ambiguous-board" });
    expect(texts).toHaveLength(0);
  });

  test("an admin who joins later gets the card posted again, the old copy told it moved, and the notice in reply", async () => {
    const first = rig();
    await handleDecisionTimeout(escalated(), first.deps);
    const { deps, texts } = rig({
      sendText: async (userId, roomId, body, extra) => {
        texts.push({ userId, roomId, body, ...(extra ? { extra } : {}) });
        return `$again${texts.length}`;
      },
    });
    expect(await repostEscalationsOnJoin(BOARD, ADMIN, deps)).toBe(1);
    expect(texts.map((t) => t.extra?.suite_event_type ?? t.body)).toEqual([CHECKS_WAITING_TYPE, MOVED_BELOW_TEXT, DECISION_ESCALATED_SUITE_TYPE]);
    expect(texts[1]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$text1" } });
    expect(texts[2]?.extra?.["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$again1" } });
    const [waiting] = await db.select().from(matrixChecksWaiting).where(eq(matrixChecksWaiting.boardId, BOARD));
    expect(waiting?.eventId).toBe("$again1");
  });
});

/** A check.override.v2 referencing `eventId`. */
const overrideMessage = (eventId: string) => ({
  msgtype: "m.text",
  body: "Override quality: the grader is down",
  schema_version: 1,
  suite_event_type: CHECK_OVERRIDE_V2_SUITE_TYPE,
  board_id: BOARD,
  card_id: CARD,
  check_name: "quality",
  comment: "the grader is down",
  "m.relates_to": { rel_type: "m.reference", event_id: eventId },
});

describe("an override from chat references the card's current copy", () => {
  test("is carried for the card this hub recorded, and refused for one it moved or never posted", async () => {
    await waitingCard({ eventId: "$current" });
    const calls: unknown[] = [];
    const deps = {
      principalForMatrixId: async () => ({ id: "prn_rakesh", kind: "human" as const }),
      recordedChecksCard,
      override: async (input: unknown) => {
        calls.push(input);
        return { ok: true as const };
      },
      reply: async () => null,
    };
    expect(await handleCheckOverride({ sender: "@rakesh:test", content: overrideMessage("$current") }, ROOM, deps)).toEqual({ status: "overridden" });
    expect(calls).toEqual([
      { tenantId: BOOTSTRAP_TENANT_ID, boardId: BOARD, cardId: CARD, checkName: "quality", comment: "the grader is down", principalId: "prn_rakesh", senderMxid: "@rakesh:test" },
    ]);
    expect(await handleCheckOverride({ sender: "@rakesh:test", content: overrideMessage("$moved-away") }, ROOM, deps)).toEqual({
      status: "refused",
      reason: "unknown-card",
    });
    expect(calls).toHaveLength(1);
  });
});
