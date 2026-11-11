process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";

import { rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { DELIVERY_V2_SUITE_TYPE, type DeliveryPendingDelivery } from "@superjackfruitlabs/treaty-matrix-events";
import {
  claimDeliveryOutcome,
  projectDelivery,
  recordedDelivery,
  type DeliveryProjectionDeps,
} from "./delivery-projection";

/**
 * Posting a delivery follow-up into its gate's board room exactly once — the claim taken before
 * the send, given back when the send fails — and the record its answer is judged against.
 */
const ROOM = "!board-room:id.example";
const SPEAKER = "@agent_superpipeline:id.example";
const RUN = crypto.randomUUID().slice(0, 8);
let n = 0;
let events = 0;

function owed(over: Partial<DeliveryPendingDelivery> = {}): DeliveryPendingDelivery {
  return {
    event: "delivery.pending",
    boardId: `brd_test_${RUN}`,
    boardName: "Release board",
    cardId: "crd_6b40",
    cardTitle: "Announce the release",
    gateId: `gate_test_${RUN}_${++n}`,
    stageKey: "approve",
    approvalSubject: {
      id: "aps_2c9e71",
      digest: "sha256:9b2f4e0c1a7d",
      schema: "social-publish/v1",
      revision: 1,
      expiresAt: "2030-01-02T03:04:05Z",
      preview: [{ type: "text", label: "Post", text: "Our next release ships today." }],
      previewComplete: true,
    },
    options: [
      { id: "record_live_url", label: "Record the live link", meaning: "defer", needsComment: false, input: { kind: "url", label: "Live link", required: true, maxLength: 2000 } },
      { id: "switch_to_automatic", label: "Post it automatically", meaning: "approve", needsComment: false, delivery: "automatic" },
    ],
    ts: "2026-11-07T10:00:00.000Z",
    ...over,
  };
}

function rig(over: Partial<DeliveryProjectionDeps> = {}) {
  const sent: Array<{ roomId: string; body: string; extra?: Record<string, unknown> }> = [];
  const deps: DeliveryProjectionDeps = {
    boardRoom: async () => ({ roomId: ROOM, speakerMxid: SPEAKER }),
    sendText: async (_user, roomId, body, extra) => {
      sent.push({ roomId, body, extra });
      return `$delivery-${RUN}-${++events}`;
    },
    ...over,
  };
  return { deps, sent };
}

beforeAll(async () => {
  await ensurePgMigrations();
});

afterEach(async () => {
  await rawSql`DELETE FROM matrix_delivery_events WHERE gate_id LIKE ${"gate_test_" + RUN + "%"}`;
});

describe("a delivery follow-up is posted into its board's room", () => {
  test("posts one delivery.v2 message, and records what it offered", async () => {
    const d = owed();
    const { deps, sent } = rig();
    const out = await projectDelivery(BOOTSTRAP_TENANT_ID, d, deps);

    expect(out.status).toBe("posted");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.extra).toMatchObject({ suite_event_type: DELIVERY_V2_SUITE_TYPE, gate_id: d.gateId });
    expect(await recordedDelivery(d.gateId)).toMatchObject({
      boardId: d.boardId,
      roomId: ROOM,
      eventId: out.status === "posted" ? out.eventId : "",
      subjectPreviewComplete: true,
      options: [{ id: "record_live_url" }, { id: "switch_to_automatic" }],
    });
  });

  test("a redelivered follow-up is posted once", async () => {
    const d = owed();
    expect((await projectDelivery(BOOTSTRAP_TENANT_ID, d, rig().deps)).status).toBe("posted");
    const second = rig();
    expect((await projectDelivery(BOOTSTRAP_TENANT_ID, d, second.deps)).status).toBe("already");
    expect(second.sent).toHaveLength(0);
  });

  test("a send that throws gives the claim back, and re-throws", async () => {
    const d = owed();
    const { deps } = rig({
      sendText: async () => {
        throw new Error("M_FORBIDDEN");
      },
    });
    await expect(projectDelivery(BOOTSTRAP_TENANT_ID, d, deps)).rejects.toThrow("M_FORBIDDEN");
    expect(await rawSql`SELECT 1 FROM matrix_delivery_events WHERE gate_id = ${d.gateId}`).toHaveLength(0);
  });

  test("a refused send gives the claim back", async () => {
    const d = owed();
    expect((await projectDelivery(BOOTSTRAP_TENANT_ID, d, rig({ sendText: async () => null }).deps)).status).toBe("not-accepted");
    expect(await rawSql`SELECT 1 FROM matrix_delivery_events WHERE gate_id = ${d.gateId}`).toHaveLength(0);
  });

  test("held, with no row, until a human has joined the room", async () => {
    const d = owed();
    const { deps, sent } = rig({ humanJoined: async () => false });
    expect((await projectDelivery(BOOTSTRAP_TENANT_ID, d, deps)).status).toBe("awaiting-join");
    expect(sent).toHaveLength(0);
    expect(await recordedDelivery(d.gateId)).toBeNull();
  });

  test("the receipt is claimed once", async () => {
    const d = owed();
    await projectDelivery(BOOTSTRAP_TENANT_ID, d, rig().deps);
    expect(await claimDeliveryOutcome(d.gateId)).toBe(true);
    expect(await claimDeliveryOutcome(d.gateId)).toBe(false);
  });
});
