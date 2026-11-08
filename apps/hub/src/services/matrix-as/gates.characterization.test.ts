/**
 * Characterization: the exact traffic of the gate projection service, pinned before it splits.
 *
 * gates.test.ts, gates-embedded.test.ts and gates-reassignment.test.ts prove the behaviours one
 * by one. This file pins the WHOLE of what each exported operation does, as it is today, so a
 * restructure that moves the code cannot change any of it unnoticed:
 *
 *   - projectGate: every dependency call in order with its arguments, the `matrix_gate_events`
 *     row as it stands at each send and afterwards, the push classification of each event id,
 *     and the outcome — for every branch (no room, held, already, sent with and without the
 *     legacy event, a throwing send, an unaccepted send, a failing onPosted);
 *   - handleGateDecision: the dependency calls and the result for every refusal and the resolve,
 *     including the exact words said back in the room and the receipt;
 *   - resolveGateAtSuperpipeline: the minted subject, the request (url, method, headers, body)
 *     and the result for every way the board or the plane can answer;
 *   - settleGateOutcome: the reply and the structured receipt for each decision, and the cases
 *     that post nothing or swallow a failure;
 *   - tenantForBoard, projectionForGate and roomAgentUser against the real tables.
 *
 * Volatile values (the run id, uuids) are replaced by placeholders before comparing.
 * Uses the local Docker test-postgres (localhost:5434).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../../../tests/helpers/database";
import { createPrincipal, forgetPrincipals } from "../../../tests/helpers/principals";
import { db, rawSql } from "../../db/drizzle";
import { stations } from "../../db/schema/stations";
import { matrixGateEvents, matrixRooms } from "../../db/schema/matrix";
import { bridgeDispatches } from "../../db/schema/bridge";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { mintEnrollmentToken, enrollNode } from "../nodes/enrollment";
import { _resetHubEventsForTest, hubEventKind } from "../push/hub-events";
import { OrgPlaneError } from "../../auth/org-plane/client";
import { AssertionMismatch } from "../../auth/org-plane/assertion";
import {
  GATE_DECISION_SUITE_TYPE,
  handleGateDecision,
  projectGate,
  projectionForGate,
  resolveGateAtSuperpipeline,
  roomAgentUser,
  settleGateOutcome,
  tenantForBoard,
  type GateDecisionDeps,
  type GateDecisionEvent,
  type GatePendingDelivery,
  type GateProjectionDeps,
} from "./gates";

const RUN = crypto.randomUUID().slice(0, 8);
const ACTOR = `test-gates-char-${RUN}`;
const BOARD = `brd_gchar_${RUN}`;
const BOARD_ROOM = `!gchar-board-${RUN}:id.agentpod.dev`;
const SPEAKER = "@agent_superpipeline:id.agentpod.dev";
const HANDLE = `gates-char-${RUN}`;
const HARNESS_HANDLE = `gates-char-h-${RUN}`;
let nodeId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: ACTOR, email: `${ACTOR}@example.com`, name: "Actor", role: "admin" });
  const { token } = await mintEnrollmentToken(ACTOR, BOOTSTRAP_TENANT_ID);
  ({ nodeId } = await enrollNode(token, { hostname: `gates-char-${RUN}`, os: "linux", arch: "amd64", cpuCount: 1 }));
});

afterEach(() => {
  delete process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS;
});

afterAll(async () => {
  await rawSql`DELETE FROM matrix_gate_events WHERE board_id = ${BOARD}`;
  await rawSql`DELETE FROM bridge_dispatches WHERE board_id = ${BOARD}`;
  await rawSql`DELETE FROM matrix_rooms WHERE room_id LIKE ${"!gchar-%" + RUN + "%"}`;
  await rawSql`DELETE FROM stations WHERE user_id = ${ACTOR}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${ACTOR}`;
  await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${ACTOR}`;
  await forgetPrincipals({ handles: [HANDLE, HARNESS_HANDLE] });
  await deleteTestUser(ACTOR);
});

// ─── Rig ──────────────────────────────────────────────────────────────────────

function normalize(value: unknown): unknown {
  const text = JSON.stringify(value)
    .split(RUN)
    .join("<run>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
  return JSON.parse(text);
}

/** Gate number `seq` of this run. Each test names its own numbers (the ones it had when the file
 *  ran top to bottom), so a test run alone with `-t` sees the same ids as in the full file. */
function gate(seq: number): GatePendingDelivery {
  return {
    event: "gate.pending",
    boardId: BOARD,
    boardName: "Char board",
    cardId: `crd_${seq}`,
    gateId: `gate_${RUN}_${seq}`,
    stageKey: "review",
    returnStageKey: "code",
    cardTitle: "Ship the fix",
    producedBy: "agt_x",
    handoffSummary: "Fixed the thing.",
    options: [
      { id: "approve", label: "Approve" },
      { id: "request_changes", label: "Changes" },
      { id: "maybe", label: "Not a GateDecision" },
    ],
    ts: "2026-09-28T00:00:00.000Z",
  };
}

async function gateRow(gateId: string) {
  const [row] = await db.select().from(matrixGateEvents).where(eq(matrixGateEvents.gateId, gateId));
  if (!row) return null;
  return {
    tenantId: row.tenantId,
    boardId: row.boardId,
    cardId: row.cardId,
    roomId: row.roomId,
    eventId: row.eventId,
    proseEventId: row.proseEventId,
  };
}

interface ProjectionRig {
  trace: unknown[][];
  ids: string[];
  deps: GateProjectionDeps;
}

/** Every dependency call recorded in order; each send also records the gate's row at that moment. */
function projectionRig(gateId: string, over: Partial<{
  room: { roomId: string; speakerMxid: string } | null;
  joined: boolean | undefined;
  prose: () => Promise<string | null>;
  custom: () => Promise<string | null>;
  onPosted: () => Promise<void>;
}> = {}): ProjectionRig {
  const trace: unknown[][] = [];
  const ids: string[] = [];
  let n = 0;
  const nextId = async (kind: string) => {
    const id = `$${kind}-${gateId}-${++n}`;
    ids.push(id);
    return id;
  };
  const deps: GateProjectionDeps = {
    domain: "id.agentpod.dev",
    boardBaseUrl: "https://board.example/app//",
    boardRoom: async (boardId, tenantId, opts) => {
      trace.push(["boardRoom", boardId, tenantId, opts]);
      return over.room === undefined ? { roomId: BOARD_ROOM, speakerMxid: SPEAKER } : over.room;
    },
    sendText: async (userId, roomId, body, extra) => {
      trace.push(["sendText", userId, roomId, body, extra, await gateRow(gateId)]);
      return over.prose ? over.prose() : nextId("prose");
    },
    sendCustomEvent: async (userId, roomId, type, content) => {
      trace.push(["sendCustomEvent", userId, roomId, type, content, await gateRow(gateId)]);
      return over.custom ? over.custom() : nextId("gate");
    },
    onPosted: async (d, posted) => {
      trace.push(["onPosted", d.gateId, posted]);
      if (over.onPosted) await over.onPosted();
    },
  };
  if (over.joined !== undefined) {
    const joined = over.joined;
    deps.humanJoined = async (roomId, speaker) => {
      trace.push(["humanJoined", roomId, speaker]);
      return joined;
    };
  }
  return { trace, ids, deps };
}

// ─── projectGate ──────────────────────────────────────────────────────────────

describe("projectGate", () => {
  test("sent, legacy on: prose (carrying the card) then the custom event, the claim taken before both", async () => {
    _resetHubEventsForTest();
    const d = gate(1);
    const rig = projectionRig(d.gateId, { joined: true });
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, rig.deps);
    expect(normalize({ outcome, trace: rig.trace, row: await gateRow(d.gateId), kinds: rig.ids.map((id) => [id, hubEventKind(id)]) })).toMatchInlineSnapshot(`
      {
        "kinds": [
          [
            "$prose-gate_<run>_1-1",
            "gate",
          ],
          [
            "$gate-gate_<run>_1-2",
            "companion",
          ],
        ],
        "outcome": {
          "eventId": "$gate-gate_<run>_1-2",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "status": "sent",
        },
        "row": {
          "boardId": "brd_gchar_<run>",
          "cardId": "crd_1",
          "eventId": "$gate-gate_<run>_1-2",
          "proseEventId": "$prose-gate_<run>_1-1",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "tenantId": "fleet_00000000000000000000",
        },
        "trace": [
          [
            "boardRoom",
            "brd_gchar_<run>",
            "fleet_00000000000000000000",
            {
              "boardName": "Char board",
            },
          ],
          [
            "humanJoined",
            "!gchar-board-<run>:id.agentpod.dev",
            "@agent_superpipeline:id.agentpod.dev",
          ],
          [
            "sendText",
            "@agent_superpipeline:id.agentpod.dev",
            "!gchar-board-<run>:id.agentpod.dev",
            "Approval needed — "Ship the fix" at stage \`review\`. Approve, request changes, or reject. [Open the card](https://board.example/app/b/brd_gchar_<run>/c/crd_1)",
            {
              "board_id": "brd_gchar_<run>",
              "card_id": "crd_1",
              "card_title": "Ship the fix",
              "deep_link": "https://board.example/app/b/brd_gchar_<run>/c/crd_1",
              "dev.superpipeline.gate": {
                "board_id": "brd_gchar_<run>",
                "card_id": "crd_1",
                "card_title": "Ship the fix",
                "deep_link": "https://board.example/app/b/brd_gchar_<run>/c/crd_1",
                "gate_id": "gate_<run>_1",
                "handoff_summary": "Fixed the thing.",
                "options": [
                  {
                    "id": "approve",
                    "label": "Approve",
                  },
                  {
                    "id": "request_changes",
                    "label": "Changes",
                  },
                ],
                "produced_by": "agt_x",
                "prompt": "Approve "Ship the fix"?",
                "return_stage_key": "code",
                "schema_version": 2,
                "stage_key": "review",
              },
              "gate_id": "gate_<run>_1",
              "handoff_summary": "Fixed the thing.",
              "msgtype": "m.text",
              "options": [
                {
                  "id": "approve",
                  "label": "Approve",
                  "meaning": "approve",
                  "needs_comment": false,
                },
                {
                  "id": "request_changes",
                  "label": "Changes",
                  "meaning": "revise",
                  "needs_comment": true,
                },
                {
                  "id": "maybe",
                  "label": "Not a GateDecision",
                  "meaning": "defer",
                  "needs_comment": false,
                },
              ],
              "produced_by": "agt_x",
              "prompt": "Approve "Ship the fix"?",
              "return_stage_key": "code",
              "schema_version": 1,
              "stage_key": "review",
              "suite_event_type": "dev.superpipeline.gate.v2",
            },
            {
              "boardId": "brd_gchar_<run>",
              "cardId": "crd_1",
              "eventId": "pending:gate_<run>_1",
              "proseEventId": null,
              "roomId": "!gchar-board-<run>:id.agentpod.dev",
              "tenantId": "fleet_00000000000000000000",
            },
          ],
          [
            "sendCustomEvent",
            "@agent_superpipeline:id.agentpod.dev",
            "!gchar-board-<run>:id.agentpod.dev",
            "dev.superpipeline.gate.v1",
            {
              "board_id": "brd_gchar_<run>",
              "body": "Approval needed — "Ship the fix" at stage \`review\`. Approve, request changes, or reject. [Open the card](https://board.example/app/b/brd_gchar_<run>/c/crd_1)",
              "card_id": "crd_1",
              "card_title": "Ship the fix",
              "deep_link": "https://board.example/app/b/brd_gchar_<run>/c/crd_1",
              "gate_id": "gate_<run>_1",
              "handoff_summary": "Fixed the thing.",
              "options": [
                {
                  "id": "approve",
                  "label": "Approve",
                },
                {
                  "id": "request_changes",
                  "label": "Changes",
                },
              ],
              "produced_by": "agt_x",
              "prompt": "Approve "Ship the fix"?",
              "return_stage_key": "code",
              "schema_version": 2,
              "stage_key": "review",
            },
            {
              "boardId": "brd_gchar_<run>",
              "cardId": "crd_1",
              "eventId": "pending:gate_<run>_1",
              "proseEventId": null,
              "roomId": "!gchar-board-<run>:id.agentpod.dev",
              "tenantId": "fleet_00000000000000000000",
            },
          ],
          [
            "onPosted",
            "gate_<run>_1",
            {
              "eventId": "$gate-gate_<run>_1-2",
              "proseEventId": "$prose-gate_<run>_1-1",
              "roomId": "!gchar-board-<run>:id.agentpod.dev",
            },
          ],
        ],
      }
    `);

    // A second delivery of the same gate: no claim, no send.
    const again = projectionRig(d.gateId, { joined: true });
    expect(normalize({ outcome: await projectGate(BOOTSTRAP_TENANT_ID, d, again.deps), trace: again.trace })).toMatchInlineSnapshot(`
      {
        "outcome": {
          "status": "already",
        },
        "trace": [
          [
            "boardRoom",
            "brd_gchar_<run>",
            "fleet_00000000000000000000",
            {
              "boardName": "Char board",
            },
          ],
          [
            "humanJoined",
            "!gchar-board-<run>:id.agentpod.dev",
            "@agent_superpipeline:id.agentpod.dev",
          ],
        ],
      }
    `);

    // Held for a join, but already posted: still `already`.
    const held = projectionRig(d.gateId, { joined: false });
    expect(await projectGate(BOOTSTRAP_TENANT_ID, d, held.deps)).toEqual({ status: "already" });
  });

  test("sent, legacy off: the prose is the only event; no link without a base url; no humanJoined dep", async () => {
    process.env.AGENTPOD_LEGACY_PERMISSION_EVENTS = "false";
    _resetHubEventsForTest();
    const d: GatePendingDelivery = { ...gate(2), boardName: null, handoffSummary: undefined };
    const rig = projectionRig(d.gateId);
    delete rig.deps.boardBaseUrl;
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, rig.deps);
    expect(normalize({ outcome, trace: rig.trace, row: await gateRow(d.gateId), kinds: rig.ids.map((id) => [id, hubEventKind(id)]) })).toMatchInlineSnapshot(`
      {
        "kinds": [
          [
            "$prose-gate_<run>_2-1",
            "gate",
          ],
        ],
        "outcome": {
          "eventId": "$prose-gate_<run>_2-1",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "status": "sent",
        },
        "row": {
          "boardId": "brd_gchar_<run>",
          "cardId": "crd_2",
          "eventId": "$prose-gate_<run>_2-1",
          "proseEventId": "$prose-gate_<run>_2-1",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "tenantId": "fleet_00000000000000000000",
        },
        "trace": [
          [
            "boardRoom",
            "brd_gchar_<run>",
            "fleet_00000000000000000000",
            {},
          ],
          [
            "sendText",
            "@agent_superpipeline:id.agentpod.dev",
            "!gchar-board-<run>:id.agentpod.dev",
            "Approval needed — "Ship the fix" at stage \`review\`. Approve, request changes, or reject.",
            {
              "board_id": "brd_gchar_<run>",
              "card_id": "crd_2",
              "card_title": "Ship the fix",
              "dev.superpipeline.gate": {
                "board_id": "brd_gchar_<run>",
                "card_id": "crd_2",
                "card_title": "Ship the fix",
                "gate_id": "gate_<run>_2",
                "options": [
                  {
                    "id": "approve",
                    "label": "Approve",
                  },
                  {
                    "id": "request_changes",
                    "label": "Changes",
                  },
                ],
                "produced_by": "agt_x",
                "prompt": "Approve "Ship the fix"?",
                "return_stage_key": "code",
                "schema_version": 2,
                "stage_key": "review",
              },
              "gate_id": "gate_<run>_2",
              "msgtype": "m.text",
              "options": [
                {
                  "id": "approve",
                  "label": "Approve",
                  "meaning": "approve",
                  "needs_comment": false,
                },
                {
                  "id": "request_changes",
                  "label": "Changes",
                  "meaning": "revise",
                  "needs_comment": true,
                },
                {
                  "id": "maybe",
                  "label": "Not a GateDecision",
                  "meaning": "defer",
                  "needs_comment": false,
                },
              ],
              "produced_by": "agt_x",
              "prompt": "Approve "Ship the fix"?",
              "return_stage_key": "code",
              "schema_version": 1,
              "stage_key": "review",
              "suite_event_type": "dev.superpipeline.gate.v2",
            },
            {
              "boardId": "brd_gchar_<run>",
              "cardId": "crd_2",
              "eventId": "pending:gate_<run>_2",
              "proseEventId": null,
              "roomId": "!gchar-board-<run>:id.agentpod.dev",
              "tenantId": "fleet_00000000000000000000",
            },
          ],
          [
            "onPosted",
            "gate_<run>_2",
            {
              "eventId": "$prose-gate_<run>_2-1",
              "proseEventId": "$prose-gate_<run>_2-1",
              "roomId": "!gchar-board-<run>:id.agentpod.dev",
            },
          ],
        ],
      }
    `);
  });

  test("no board room, and a room nobody has joined: nothing claimed, nothing sent", async () => {
    const d1 = gate(3);
    const none = projectionRig(d1.gateId, { room: null, joined: true });
    const d2 = gate(4);
    const held = projectionRig(d2.gateId, { joined: false });
    expect(
      normalize({
        none: await projectGate(BOOTSTRAP_TENANT_ID, d1, none.deps),
        noneTrace: none.trace,
        noneRow: await gateRow(d1.gateId),
        held: await projectGate(BOOTSTRAP_TENANT_ID, d2, held.deps),
        heldTrace: held.trace,
        heldRow: await gateRow(d2.gateId),
      }),
    ).toMatchInlineSnapshot(`
      {
        "held": {
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "status": "awaiting-join",
        },
        "heldRow": null,
        "heldTrace": [
          [
            "boardRoom",
            "brd_gchar_<run>",
            "fleet_00000000000000000000",
            {
              "boardName": "Char board",
            },
          ],
          [
            "humanJoined",
            "!gchar-board-<run>:id.agentpod.dev",
            "@agent_superpipeline:id.agentpod.dev",
          ],
        ],
        "none": {
          "status": "no-room",
        },
        "noneRow": null,
        "noneTrace": [
          [
            "boardRoom",
            "brd_gchar_<run>",
            "fleet_00000000000000000000",
            {
              "boardName": "Char board",
            },
          ],
        ],
      }
    `);
  });

  test("a send that throws gives the claim back and rethrows; an unaccepted send is no-room with the claim given back", async () => {
    const d1 = gate(5);
    const throwing = projectionRig(d1.gateId, {
      custom: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });
    const thrown = await projectGate(BOOTSTRAP_TENANT_ID, d1, throwing.deps).then(
      () => "resolved",
      (e: Error) => `rejected: ${e.message}`,
    );

    const d2 = gate(6);
    const refused = projectionRig(d2.gateId, { custom: async () => null });
    const refusedOutcome = await projectGate(BOOTSTRAP_TENANT_ID, d2, refused.deps);

    expect(
      normalize({
        thrown,
        thrownCalls: throwing.trace.map((t) => t[0]),
        thrownRow: await gateRow(d1.gateId),
        refusedOutcome,
        refusedCalls: refused.trace.map((t) => t[0]),
        refusedRow: await gateRow(d2.gateId),
      }),
    ).toMatchInlineSnapshot(`
      {
        "refusedCalls": [
          "boardRoom",
          "sendText",
          "sendCustomEvent",
        ],
        "refusedOutcome": {
          "status": "no-room",
        },
        "refusedRow": null,
        "thrown": "rejected: M_FORBIDDEN",
        "thrownCalls": [
          "boardRoom",
          "sendText",
          "sendCustomEvent",
        ],
        "thrownRow": null,
      }
    `);
  });

  test("an onPosted that fails costs nothing: still sent, the row still recorded", async () => {
    const d = gate(7);
    const rig = projectionRig(d.gateId, {
      onPosted: async () => {
        throw new Error("fleet card down");
      },
    });
    const outcome = await projectGate(BOOTSTRAP_TENANT_ID, d, rig.deps);
    expect(normalize({ outcome, row: await gateRow(d.gateId) })).toMatchInlineSnapshot(`
      {
        "outcome": {
          "eventId": "$gate-gate_<run>_7-2",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "status": "sent",
        },
        "row": {
          "boardId": "brd_gchar_<run>",
          "cardId": "crd_7",
          "eventId": "$gate-gate_<run>_7-2",
          "proseEventId": "$prose-gate_<run>_7-1",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "tenantId": "fleet_00000000000000000000",
        },
      }
    `);
  });
});

// ─── handleGateDecision ───────────────────────────────────────────────────────

const plane = async () => {
  throw new Error("plane down");
};

const PROJECTION = { tenantId: "tnt_x", boardId: "brd_x", eventId: "$gate", proseEventId: "$prose" };

function decisionEvent(over: Record<string, unknown> = {}) {
  return {
    sender: "@rakesh:id.agentpod.dev",
    content: {
      msgtype: "m.text",
      body: "Approved",
      suite_event_type: GATE_DECISION_SUITE_TYPE,
      gate_id: "gate_d",
      option_id: "request_changes",
      comment: "Tighten it",
      "m.relates_to": { rel_type: "m.reference", event_id: "$prose" },
      ...over,
    },
  };
}

function decisionRig(over: Partial<{
  principal: () => Promise<{ id: string; kind: "human" | "agent" | "service" } | null>;
  projection: typeof PROJECTION | null;
  resolve: { ok: true } | { ok: false; code: string };
}> = {}) {
  const trace: unknown[][] = [];
  const deps: GateDecisionDeps = {
    principalForMatrixId: async (mxid) => {
      trace.push(["principalForMatrixId", mxid]);
      return over.principal ? over.principal() : { id: "prn_human", kind: "human" };
    },
    projectionFor: async (gateId) => {
      trace.push(["projectionFor", gateId]);
      return over.projection === undefined ? PROJECTION : over.projection;
    },
    resolveGate: async (input) => {
      trace.push(["resolveGate", input]);
      return over.resolve ?? { ok: true };
    },
    reply: async (roomId, body) => {
      trace.push(["reply", roomId, body]);
    },
    sendOutcome: async (roomId, content) => {
      trace.push(["sendOutcome", roomId, content]);
    },
    displayNameFor: async (id) => {
      trace.push(["displayNameFor", id]);
      return "Rakesh";
    },
    markOutcomePosted: async (gateId) => {
      trace.push(["markOutcomePosted", gateId]);
      return true;
    },
  };
  return { trace, deps };
}

async function decide(event: GateDecisionEvent, over: Parameters<typeof decisionRig>[0] = {}) {
  const rig = decisionRig(over);
  const result = await handleGateDecision(event, "!room", rig.deps);
  return { result, trace: rig.trace };
}

describe("handleGateDecision", () => {
  test("a resolve: the order of every call, the resolution's input and the receipt", async () => {
    expect(await decide(decisionEvent())).toMatchInlineSnapshot(`
      {
        "result": {
          "status": "resolved",
        },
        "trace": [
          [
            "projectionFor",
            "gate_d",
          ],
          [
            "principalForMatrixId",
            "@rakesh:id.agentpod.dev",
          ],
          [
            "resolveGate",
            {
              "boardId": "brd_x",
              "comment": "Tighten it",
              "decision": "request_changes",
              "gateId": "gate_d",
              "principalId": "prn_human",
              "senderMxid": "@rakesh:id.agentpod.dev",
              "tenantId": "tnt_x",
            },
          ],
          [
            "markOutcomePosted",
            "gate_d",
          ],
          [
            "displayNameFor",
            "prn_human",
          ],
          [
            "reply",
            "!room",
            "Changes requested by Rakesh — the board has it.",
          ],
          [
            "sendOutcome",
            "!room",
            {
              "board_id": "brd_x",
              "decided_by": "Rakesh",
              "decision": "request_changes",
              "gate_id": "gate_d",
              "m.relates_to": {
                "event_id": "$gate",
                "rel_type": "m.reference",
              },
              "suite_event_type": "dev.superpipeline.gate.outcome.v1",
            },
          ],
        ],
      }
    `);
  });

  test("every refusal: its reason, how far it got, and what it said in the room", async () => {
    const cases = {
      notADecision: await decide({ sender: "@x:y", content: { msgtype: "m.text", body: "hi" } }),
      unknownGate: await decide(decisionEvent(), { projection: null }),
      noReference: await decide(decisionEvent({ "m.relates_to": undefined })),
      wrongReference: await decide(decisionEvent({ "m.relates_to": { rel_type: "m.reference", event_id: "$other" } })),
      planeDown: await decide(decisionEvent(), { principal: plane }),
      unlinked: await decide(decisionEvent(), { principal: async () => null }),
      agent: await decide(decisionEvent(), { principal: async () => ({ id: "prn_agent", kind: "agent" }) }),
      notPending: await decide(decisionEvent(), { resolve: { ok: false, code: "GATE_NOT_PENDING" } }),
      identityUnavailable: await decide(decisionEvent(), { resolve: { ok: false, code: "IDENTITY_UNAVAILABLE" } }),
      refused: await decide(decisionEvent(), { resolve: { ok: false, code: "ASSERTION_REFUSED" } }),
      mismatch: await decide(decisionEvent(), { resolve: { ok: false, code: "ASSERTION_MISMATCH" } }),
      other: await decide(decisionEvent(), { resolve: { ok: false, code: "SEPARATION_OF_DUTIES" } }),
    };
    const summary = Object.fromEntries(
      Object.entries(cases).map(([name, c]) => [
        name,
        {
          result: c.result,
          calls: c.trace.map((t) => t[0]),
          said: c.trace.filter((t) => t[0] === "reply").map((t) => t[2]),
        },
      ]),
    );
    expect(summary).toMatchInlineSnapshot(`
      {
        "agent": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
          ],
          "result": {
            "reason": "not-human",
            "status": "refused",
          },
          "said": [],
        },
        "identityUnavailable": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "resolveGate",
            "reply",
          ],
          "result": {
            "reason": "identity-unavailable",
            "status": "refused",
          },
          "said": [
            "I cannot check who you are right now — the account service is unreachable. Nothing has changed; try again in a minute.",
          ],
        },
        "mismatch": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "resolveGate",
            "reply",
          ],
          "result": {
            "reason": "assertion-refused",
            "status": "refused",
          },
          "said": [
            "That did not go through (ASSERTION_MISMATCH): the account service would not vouch for you. Nothing has changed.",
          ],
        },
        "noReference": {
          "calls": [
            "projectionFor",
          ],
          "result": {
            "reason": "reference-mismatch",
            "status": "refused",
          },
          "said": [],
        },
        "notADecision": {
          "calls": [],
          "result": {
            "reason": "not-a-decision",
            "status": "refused",
          },
          "said": [],
        },
        "notPending": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "resolveGate",
            "reply",
          ],
          "result": {
            "reason": "unknown-gate",
            "status": "refused",
          },
          "said": [
            "That was already decided — the board has it.",
          ],
        },
        "other": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "resolveGate",
          ],
          "result": {
            "reason": "unknown-gate",
            "status": "refused",
          },
          "said": [],
        },
        "planeDown": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "reply",
          ],
          "result": {
            "reason": "identity-unavailable",
            "status": "refused",
          },
          "said": [
            "I cannot check who you are right now — the account service is unreachable. Nothing has changed; try again in a minute.",
          ],
        },
        "refused": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
            "resolveGate",
            "reply",
          ],
          "result": {
            "reason": "assertion-refused",
            "status": "refused",
          },
          "said": [
            "That did not go through (ASSERTION_REFUSED): the account service would not vouch for you. Nothing has changed.",
          ],
        },
        "unknownGate": {
          "calls": [
            "projectionFor",
          ],
          "result": {
            "reason": "unknown-gate",
            "status": "refused",
          },
          "said": [],
        },
        "unlinked": {
          "calls": [
            "projectionFor",
            "principalForMatrixId",
          ],
          "result": {
            "reason": "unlinked-sender",
            "status": "refused",
          },
          "said": [],
        },
        "wrongReference": {
          "calls": [
            "projectionFor",
          ],
          "result": {
            "reason": "reference-mismatch",
            "status": "refused",
          },
          "said": [],
        },
      }
    `);
  });
});

// ─── resolveGateAtSuperpipeline ───────────────────────────────────────────────

async function resolveWith(
  answer: () => Promise<Response>,
  mint: () => Promise<string> = async () => "tok_1",
  comment: string | null = "Tighten it",
) {
  const trace: unknown[][] = [];
  const result = await resolveGateAtSuperpipeline(
    { boardId: "brd/1", gateId: "gate 1", decision: "approve", comment, principalId: "prn_h", senderMxid: "@h:x" },
    {
      baseUrl: "https://sp.example/api///",
      mint: async (subject) => {
        trace.push(["mint", subject]);
        return mint();
      },
      fetch: Object.assign(
        async (url: string | URL | Request, init?: RequestInit) => {
          trace.push(["fetch", url, init]);
          return answer();
        },
        { preconnect: fetch.preconnect },
      ),
    },
  ).then(
    (r) => r,
    (e: Error) => `threw: ${e.message}`,
  );
  return { result, trace };
}

describe("resolveGateAtSuperpipeline", () => {
  test("the request it makes, and what each answer becomes", async () => {
    const ok = await resolveWith(async () => new Response("{}", { status: 200 }));
    expect(ok).toMatchInlineSnapshot(`
      {
        "result": {
          "ok": true,
        },
        "trace": [
          [
            "mint",
            {
              "principalId": "prn_h",
              "senderMxid": "@h:x",
            },
          ],
          [
            "fetch",
            "https://sp.example/api/v1/boards/brd%2F1/gates/gate%201/resolve",
            {
              "body": "{"decision":"approve","comment":"Tighten it"}",
              "headers": {
                "Authorization": "Bearer tok_1",
                "Content-Type": "application/json",
              },
              "method": "POST",
            },
          ],
        ],
      }
    `);
    const results = {
      noComment: (await resolveWith(async () => new Response("{}"), undefined, null)).trace[1],
      coded: (await resolveWith(async () => Response.json({ error: { code: "GATE_NOT_PENDING" } }, { status: 409 }))).result,
      uncoded: (await resolveWith(async () => new Response("<html>", { status: 502 }))).result,
      unreachable: (await resolveWith(async () => {
        throw new Error("ECONNREFUSED");
      })).result,
      planeDown: await resolveWith(async () => new Response("{}"), async () => {
        throw new OrgPlaneError(503, "down");
      }),
      planeRefused: (await resolveWith(async () => new Response("{}"), async () => {
        throw new OrgPlaneError(403, "nope");
      })).result,
      mismatch: (await resolveWith(async () => new Response("{}"), async () => {
        throw new AssertionMismatch("prn_h", "prn_other");
      })).result,
      otherMintFailure: await resolveWith(async () => new Response("{}"), async () => {
        throw new Error("boom");
      }),
    };
    expect(results).toMatchInlineSnapshot(`
      {
        "coded": {
          "code": "GATE_NOT_PENDING",
          "ok": false,
        },
        "mismatch": {
          "code": "ASSERTION_MISMATCH",
          "ok": false,
        },
        "noComment": [
          "fetch",
          "https://sp.example/api/v1/boards/brd%2F1/gates/gate%201/resolve",
          {
            "body": "{"decision":"approve"}",
            "headers": {
              "Authorization": "Bearer tok_1",
              "Content-Type": "application/json",
            },
            "method": "POST",
          },
        ],
        "otherMintFailure": {
          "result": "threw: boom",
          "trace": [
            [
              "mint",
              {
                "principalId": "prn_h",
                "senderMxid": "@h:x",
              },
            ],
          ],
        },
        "planeDown": {
          "result": {
            "code": "IDENTITY_UNAVAILABLE",
            "ok": false,
          },
          "trace": [
            [
              "mint",
              {
                "principalId": "prn_h",
                "senderMxid": "@h:x",
              },
            ],
          ],
        },
        "planeRefused": {
          "code": "ASSERTION_REFUSED",
          "ok": false,
        },
        "uncoded": {
          "code": "HTTP_502",
          "ok": false,
        },
        "unreachable": {
          "code": "UNREACHABLE",
          "ok": false,
        },
      }
    `);
  });
});

// ─── settleGateOutcome ────────────────────────────────────────────────────────

const settle = async (
  decided: { gateId: string; decision: string; decidedBy: string | null },
  over: Partial<{ claimed: boolean; replyFails: boolean; noOutcome: boolean }> = {},
) => {
  const trace: unknown[][] = [];
  const deps: Parameters<typeof settleGateOutcome>[3] = {
    markOutcomePosted: async (g) => {
      trace.push(["markOutcomePosted", g]);
      return !over.claimed;
    },
    displayNameFor: async (p) => {
      trace.push(["displayNameFor", p]);
      return p === "prn_anon" ? null : "Asha";
    },
    reply: async (r, b) => {
      trace.push(["reply", r, b]);
      if (over.replyFails) throw new Error("homeserver down");
    },
  };
  if (!over.noOutcome) {
    deps.sendOutcome = async (r, c) => {
      trace.push(["sendOutcome", r, c.decided_by, c.decision]);
    };
  }
  await settleGateOutcome(decided, "!r", { boardId: "brd", eventId: "$g", proseEventId: null }, deps);
  return trace;
};

describe("settleGateOutcome", () => {
  test("the words for each decision, an unknown one, nobody named, an already-claimed one, a failing reply", async () => {
    expect({
      approve: await settle({ gateId: "g1", decision: "approve", decidedBy: "prn_a" }),
      reject: await settle({ gateId: "g2", decision: "reject", decidedBy: "prn_anon" }),
      unknown: await settle({ gateId: "g3", decision: "defer", decidedBy: null }, { noOutcome: true }),
      claimed: await settle({ gateId: "g4", decision: "approve", decidedBy: "prn_a" }, { claimed: true }),
      replyFails: await settle({ gateId: "g5", decision: "approve", decidedBy: "prn_a" }, { replyFails: true }),
    }).toMatchInlineSnapshot(`
      {
        "approve": [
          [
            "markOutcomePosted",
            "g1",
          ],
          [
            "displayNameFor",
            "prn_a",
          ],
          [
            "reply",
            "!r",
            "Approved by Asha — the board has it.",
          ],
          [
            "sendOutcome",
            "!r",
            "Asha",
            "approve",
          ],
        ],
        "claimed": [
          [
            "markOutcomePosted",
            "g4",
          ],
        ],
        "reject": [
          [
            "markOutcomePosted",
            "g2",
          ],
          [
            "displayNameFor",
            "prn_anon",
          ],
          [
            "reply",
            "!r",
            "Rejected — the board has it.",
          ],
          [
            "sendOutcome",
            "!r",
            null,
            "reject",
          ],
        ],
        "replyFails": [
          [
            "markOutcomePosted",
            "g5",
          ],
          [
            "displayNameFor",
            "prn_a",
          ],
          [
            "reply",
            "!r",
            "Approved by Asha — the board has it.",
          ],
        ],
        "unknown": [
          [
            "markOutcomePosted",
            "g3",
          ],
          [
            "reply",
            "!r",
            "defer — the board has it.",
          ],
        ],
      }
    `);
  });
});

// ─── The reads ────────────────────────────────────────────────────────────────

describe("the reads", () => {
  test("tenantForBoard, projectionForGate and roomAgentUser against the real tables", async () => {
    const principalId = await createPrincipal({ kind: "agent", handle: HANDLE });
    const harnessPrincipalId = await createPrincipal({ kind: "agent", handle: HARNESS_HANDLE });
    const bridgeStation = `st_gchar_b_${RUN}`;
    const harnessStation = `st_gchar_h_${RUN}`;
    await db.insert(stations).values([
      {
        id: bridgeStation,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ACTOR,
        nodeId,
        harness: "opencode",
        stationKey: `opencode:b-${RUN}`,
        kind: "workspace",
        displayName: "Bridge",
        principalId,
      },
      {
        id: harnessStation,
        tenantId: BOOTSTRAP_TENANT_ID,
        userId: ACTOR,
        nodeId,
        harness: "hermes",
        stationKey: `hermes:h-${RUN}`,
        kind: "workspace",
        displayName: "Harness",
        principalId: harnessPrincipalId,
        matrixIdentityMode: "harness",
        matrixId: "@hermes_own:id.agentpod.dev",
      },
    ]);
    await db.insert(matrixRooms).values([
      { roomId: `!gchar-b-${RUN}:x`, tenantId: BOOTSTRAP_TENANT_ID, stationId: bridgeStation, principalId, alias: `#gchar-b-${RUN}:x` },
      { roomId: `!gchar-h-${RUN}:x`, tenantId: BOOTSTRAP_TENANT_ID, stationId: harnessStation, principalId: harnessPrincipalId, alias: `#gchar-h-${RUN}:x` },
      { roomId: `!gchar-u-${RUN}:x`, tenantId: BOOTSTRAP_TENANT_ID, stationId: bridgeStation, principalId: null, alias: `#gchar-u-${RUN}:x` },
    ]);
    await db.insert(bridgeDispatches).values({
      externalSource: "superpipeline",
      externalRunId: `run_gchar_${RUN}`,
      tenantId: BOOTSTRAP_TENANT_ID,
      boardId: BOARD,
      externalCardId: "crd_read",
      agentKey: "test",
      stationId: bridgeStation,
      leaseEpoch: 1,
      outcome: "produced",
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    // The projection this test reads is its own, so the test passes run alone with `-t`.
    await db.insert(matrixGateEvents).values({
      gateId: `gate_${RUN}_8`,
      tenantId: BOOTSTRAP_TENANT_ID,
      boardId: BOARD,
      cardId: "crd_8",
      roomId: BOARD_ROOM,
      eventId: `$gate-gate_${RUN}_8-2`,
      proseEventId: `$prose-gate_${RUN}_8-1`,
    });

    expect(
      normalize({
        tenant: await tenantForBoard(BOARD),
        noTenant: await tenantForBoard(`brd_none_${RUN}`),
        projection: await projectionForGate(`gate_${RUN}_8`),
        noProjection: await projectionForGate("gate_never"),
        bridgeSpeaker: await roomAgentUser(`!gchar-b-${RUN}:x`, "id.agentpod.dev"),
        harnessSpeaker: await roomAgentUser(`!gchar-h-${RUN}:x`, "id.agentpod.dev"),
        unboundRoom: await roomAgentUser(`!gchar-u-${RUN}:x`, "id.agentpod.dev"),
        unknownRoom: await roomAgentUser(`!gchar-none-${RUN}:x`, "id.agentpod.dev"),
      }),
    ).toMatchInlineSnapshot(`
      {
        "bridgeSpeaker": "@agent_gates-char-<run>:id.agentpod.dev",
        "harnessSpeaker": "@hermes_own:id.agentpod.dev",
        "noProjection": null,
        "noTenant": null,
        "projection": {
          "boardId": "brd_gchar_<run>",
          "eventId": "$gate-gate_<run>_8-2",
          "options": null,
          "proseEventId": "$prose-gate_<run>_8-1",
          "roomId": "!gchar-board-<run>:id.agentpod.dev",
          "subjectDigest": null,
          "subjectId": null,
          "subjectPreviewComplete": null,
          "tenantId": "fleet_00000000000000000000",
          "variants": null,
        },
        "tenant": "fleet_00000000000000000000",
        "unboundRoom": null,
        "unknownRoom": null,
      }
    `);
  });
});
