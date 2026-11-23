/**
 * The event ids both SuperPipeline doors share, against the database (treaty phase 2, ruling 2):
 * one claim wins however many arrive at once, a released claim can be taken again, and a receipt
 * older than its week is pruned.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { superpipelineEventReceipts } from "../../src/db/schema/event-receipts";
import { createEventReceipts } from "../../src/services/bridge";
import { RECEIPT_TTL_MS } from "../../src/services/bridge/event-receipts";
import { ensurePgMigrations } from "../helpers/pg-migrations";

const PREFIX = "brd_receipts_test:";

beforeAll(async () => {
  await ensurePgMigrations();
});
afterAll(async () => {
  await db.delete(superpipelineEventReceipts).where(like(superpipelineEventReceipts.eventId, `${PREFIX}%`));
});

describe("event receipts", () => {
  test("the first claim wins, and a second is a duplicate", async () => {
    const receipts = createEventReceipts();
    expect(await receipts.claim(`${PREFIX}1`, "event-relay")).toBe(true);
    expect(await receipts.claim(`${PREFIX}1`, "push")).toBe(false);
  });

  test("two doors claiming at the same moment: exactly one wins", async () => {
    const a = createEventReceipts();
    const b = createEventReceipts();
    const won = await Promise.all([a.claim(`${PREFIX}2`, "push"), b.claim(`${PREFIX}2`, "event-relay")]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  test("a released claim is taken again", async () => {
    const receipts = createEventReceipts();
    expect(await receipts.claim(`${PREFIX}3`, "push")).toBe(true);
    await receipts.release(`${PREFIX}3`);
    expect(await receipts.claim(`${PREFIX}3`, "event-relay")).toBe(true);
  });

  test("a receipt past its week is pruned, so its id could be claimed again", async () => {
    let now = Date.now() - RECEIPT_TTL_MS - 60_000;
    const receipts = createEventReceipts(() => now);
    expect(await receipts.claim(`${PREFIX}4`, "push")).toBe(true);
    now = Date.now() + 2 * 60 * 60 * 1000;
    // The next claim prunes first (an hour has passed since the last prune).
    expect(await receipts.claim(`${PREFIX}5`, "push")).toBe(true);
    expect(await receipts.claim(`${PREFIX}4`, "push")).toBe(true);
  });
});
