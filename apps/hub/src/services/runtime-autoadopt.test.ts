/**
 * Unit / Integration Test: runtime-autoadopt service (P4B Task 4)
 *
 * Tests `autoAdoptProvisionedHarness(nodeId, deps)` with:
 *   - A real Postgres DB on :5434 for provisioned_runtimes, stations, nodes.
 *   - An injected fake brokerRequest to avoid a live WebSocket.
 *
 * Cases covered:
 *   1. Provisioned row harness "opencode" + no adopted station + detect returns
 *      an opencode station at /workspace and an unrelated claude-code station →
 *      the opencode station is adopted (only that key, correct userId).
 *   2. Idempotent: calling again (station now adopted) → broker NOT called again,
 *      no new row created.
 *   3. Harness "none" → no detect call, no adopt.
 *   4. No provisioned row for node → no detect call, no adopt.
 *   5. broker.request {ok:false} → no adopt, no throw.
 *
 * Requires DATABASE_URL set before any src/ imports.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { db, rawSql } from "../db/drizzle";
import { provisionedRuntimes } from "../db/schema/nodes";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { mintEnrollmentToken, enrollNode } from "./enrollment";
import { listAdopted } from "./station-registry";
import { autoAdoptProvisionedHarness } from "./runtime-autoadopt";
import type { Station } from "@agentpod/contract";

// ─── Constants ────────────────────────────────────────────────────────────────

const TEST_USER = "test-user-autoadopt-001";

// Resolved in beforeAll
let testNodeId = "";      // node with harness "opencode"
let noneNodeId = "";      // node with harness "none"

// ─── Fake detect data ─────────────────────────────────────────────────────────

/** Two stations: one opencode at /workspace, one unrelated. */
const FAKE_STATIONS: Station[] = [
  {
    key: "opencode-workspace",
    harness: "opencode",
    kind: "leaf",
    displayName: "OpenCode /workspace",
    parentKey: null,
    workspacePath: "/workspace",
    capabilities: ["health"],
    matrixId: null,
  },
  {
    key: "claude-code-other",
    harness: "claude-code",
    kind: "leaf",
    displayName: "Claude Code",
    parentKey: null,
    workspacePath: "/other",
    capabilities: [],
    matrixId: null,
  },
];

/** A brokerRequest fake that always succeeds with the fake station list. */
const fakeDetectOk = async (
  _nodeId: string,
  _verb: string,
  _params: unknown,
  _opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; data?: unknown; error?: string }> => ({
  ok: true,
  data: FAKE_STATIONS,
});

/** A brokerRequest fake that always returns ok:false. */
const fakeDetectFail = async (
  _nodeId: string,
  _verb: string,
  _params: unknown,
  _opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; data?: unknown; error?: string }> => ({
  ok: false,
  error: "timeout",
});

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();

  await createTestUser({
    id: TEST_USER,
    email: "autoadopt-test@example.com",
    name: "Auto Adopt Test User",
  });

  // ── Node 1: harness "opencode" ────────────────────────────────────────────
  const tokenA = await mintEnrollmentToken(TEST_USER);
  const enrolledA = await enrollNode(tokenA.token, {
    hostname: "autoadopt-host-opencode",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  testNodeId = enrolledA.nodeId;

  await db.insert(provisionedRuntimes).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    id: `runtime_autoadopt_opencode_${crypto.randomUUID().slice(0, 8)}`,
    userId: TEST_USER,
    provider: "docker",
    name: "opencode-runtime",
    nodeId: testNodeId,
    harness: "opencode",
    status: "online",
  });

  // ── Node 2: harness "none" ────────────────────────────────────────────────
  const tokenB = await mintEnrollmentToken(TEST_USER);
  const enrolledB = await enrollNode(tokenB.token, {
    hostname: "autoadopt-host-none",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  noneNodeId = enrolledB.nodeId;

  await db.insert(provisionedRuntimes).values({
    tenantId: BOOTSTRAP_TENANT_ID,
    id: `runtime_autoadopt_none_${crypto.randomUUID().slice(0, 8)}`,
    userId: TEST_USER,
    provider: "docker",
    name: "none-runtime",
    nodeId: noneNodeId,
    harness: "none",
    status: "online",
  });
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes               WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens   WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"              WHERE id      = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test(
  "harness 'opencode' + detect returns opencode station at /workspace → station adopted",
  async () => {
    // Precondition: no stations adopted yet for this node
    const before = await listAdopted(TEST_USER, testNodeId);
    expect(before).toHaveLength(0);

    await autoAdoptProvisionedHarness(testNodeId, {
      brokerRequest: fakeDetectOk,
    });

    const after = await listAdopted(TEST_USER, testNodeId);
    expect(after).toHaveLength(1);

    const adopted = after[0]!;
    expect(adopted.stationKey).toBe("opencode-workspace");
    expect(adopted.harness).toBe("opencode");
    expect(adopted.workspacePath).toBe("/workspace");
    expect(adopted.userId).toBe(TEST_USER);
  },
  30_000
);

test(
  "idempotent: calling again when station already adopted → broker not called, no new row",
  async () => {
    // At this point testNodeId already has the opencode station adopted (from test above).
    const before = await listAdopted(TEST_USER, testNodeId);
    expect(before.length).toBeGreaterThan(0);

    let brokerCallCount = 0;
    const spyBroker = async (
      _nodeId: string,
      _verb: string,
      _params: unknown,
      _opts?: { timeoutMs?: number }
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      brokerCallCount++;
      return { ok: true, data: FAKE_STATIONS };
    };

    await autoAdoptProvisionedHarness(testNodeId, { brokerRequest: spyBroker });

    // Broker must not have been called because listAdopted was already non-empty
    expect(brokerCallCount).toBe(0);

    // No extra rows created
    const after = await listAdopted(TEST_USER, testNodeId);
    expect(after).toHaveLength(before.length);
  },
  15_000
);

test(
  "harness 'none' → no detect call, no adopt",
  async () => {
    let brokerCallCount = 0;
    const spyBroker = async (
      _nodeId: string,
      _verb: string,
      _params: unknown,
      _opts?: { timeoutMs?: number }
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      brokerCallCount++;
      return { ok: true, data: [] };
    };

    // Should return immediately without calling broker
    await autoAdoptProvisionedHarness(noneNodeId, { brokerRequest: spyBroker });

    expect(brokerCallCount).toBe(0);
    const adopted = await listAdopted(TEST_USER, noneNodeId);
    expect(adopted).toHaveLength(0);
  },
  15_000
);

test(
  "no provisioned row for node → no detect call, no adopt, no throw",
  async () => {
    const unknownNodeId = `node_${crypto.randomUUID()}`;

    let brokerCallCount = 0;
    const spyBroker = async (
      _nodeId: string,
      _verb: string,
      _params: unknown,
      _opts?: { timeoutMs?: number }
    ): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
      brokerCallCount++;
      return { ok: true, data: [] };
    };

    // Must not throw and must not call broker
    await expect(
      autoAdoptProvisionedHarness(unknownNodeId, { brokerRequest: spyBroker })
    ).resolves.toBeUndefined();

    expect(brokerCallCount).toBe(0);
  },
  10_000
);

test(
  "broker.request {ok:false} → no adopt, no throw",
  async () => {
    // Use a fresh node so there are no stations adopted yet
    const tokenC = await mintEnrollmentToken(TEST_USER);
    const enrolledC = await enrollNode(tokenC.token, {
      hostname: "autoadopt-host-fail",
      os: "linux",
      arch: "amd64",
      cpuCount: 1,
    });
    const failNodeId = enrolledC.nodeId;

    await db.insert(provisionedRuntimes).values({
    tenantId: BOOTSTRAP_TENANT_ID,
      id: `runtime_autoadopt_fail_${crypto.randomUUID().slice(0, 8)}`,
      userId: TEST_USER,
      provider: "docker",
      name: "fail-runtime",
      nodeId: failNodeId,
      harness: "opencode",
      status: "online",
    });

    // Must not throw and must not adopt
    await expect(
      autoAdoptProvisionedHarness(failNodeId, { brokerRequest: fakeDetectFail })
    ).resolves.toBeUndefined();

    const adopted = await listAdopted(TEST_USER, failNodeId);
    expect(adopted).toHaveLength(0);
  },
  15_000
);
