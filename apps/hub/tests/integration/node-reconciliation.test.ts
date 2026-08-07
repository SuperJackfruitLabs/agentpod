/**
 * Integration: startup reconciliation + lastSeenAt honesty + heartbeat sweeper.
 * Uses the local Docker test-postgres (agentpod-test-postgres on localhost:5434).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { rawSql } from "../../src/db/drizzle";
import { createTestUser } from "../helpers/database";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { mintEnrollmentToken, enrollNode } from "../../src/services/enrollment";
import {
  listNodes,
  setNodeStatus,
  resetOrphanedOnlineNodes,
} from "../../src/services/node-registry";
import { sweepStaleNodes, OFFLINE_THRESHOLD_MS } from "../../src/services/node-sweeper";

const TEST_USER_ID = "test-user-reconcile-001";

async function makeNode(hostname: string): Promise<string> {
  const { token } = await mintEnrollmentToken(TEST_USER_ID);
  const { nodeId } = await enrollNode(token, {
    hostname, os: "linux", arch: "amd64", cpuCount: 1,
  });
  return nodeId;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER_ID,
    email: "reconcile-test@example.com",
    name: "Reconcile Test User",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER_ID}`;
    await rawSql`DELETE FROM "user"            WHERE id      = ${TEST_USER_ID}`;
  } catch {
    // Ignore cleanup errors
  }
});

test("resetOrphanedOnlineNodes flips online rows to offline at boot", async () => {
  const nodeId = await makeNode("boot-orphan-host");
  await setNodeStatus(nodeId, "online");

  const flipped = await resetOrphanedOnlineNodes();
  expect(flipped).toBeGreaterThanOrEqual(1);

  const node = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId);
  expect(node?.status).toBe("offline");
});

test("setNodeStatus offline does not bump lastSeenAt", async () => {
  const nodeId = await makeNode("lastseen-host");
  await setNodeStatus(nodeId, "online");
  const seenOnline = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId)!.lastSeenAt;
  expect(seenOnline).not.toBeNull();

  await new Promise((r) => setTimeout(r, 50));
  await setNodeStatus(nodeId, "offline");
  const seenOffline = (await listNodes(TEST_USER_ID)).find((n) => n.id === nodeId)!.lastSeenAt;
  // "last seen" means last actual contact — an offline transition is not contact.
  expect(seenOffline).toBe(seenOnline);
});

test("sweeper expires online nodes silent past the threshold — and not before", async () => {
  const staleId = await makeNode("sweep-stale-host");
  const freshId = await makeNode("sweep-fresh-host");
  await setNodeStatus(staleId, "online");
  await setNodeStatus(freshId, "online");

  // Age the stale node's lastSeenAt past the threshold.
  const past = new Date(Date.now() - OFFLINE_THRESHOLD_MS - 1000);
  // .toISOString(): rawSql shares its postgres.js client with drizzle(), which
  // replaces the client's date serializers/parsers with identity passthroughs
  // (drizzle-orm/postgres-js/driver.js `construct()`) so it can own timestamp
  // (de)serialization for its own typed columns. A raw Date object handed to
  // this shared client's tagged template therefore reaches postgres.js's wire
  // encoder un-stringified and throws; a string parameter passes through untouched.
  await rawSql`UPDATE nodes SET last_seen_at = ${past.toISOString()} WHERE id = ${staleId}`;

  const swept = await sweepStaleNodes();
  expect(swept).toContain(staleId);
  expect(swept).not.toContain(freshId);

  const list = await listNodes(TEST_USER_ID);
  expect(list.find((n) => n.id === staleId)?.status).toBe("offline");
  expect(list.find((n) => n.id === freshId)?.status).toBe("online");
});

test("sweeper treats online rows with NULL lastSeenAt as stale", async () => {
  const nodeId = await makeNode("sweep-null-host");
  await setNodeStatus(nodeId, "online");
  await rawSql`UPDATE nodes SET last_seen_at = NULL WHERE id = ${nodeId}`;

  const swept = await sweepStaleNodes();
  expect(swept).toContain(nodeId);
});
