/**
 * Integration Test: station-registry — matrixId persist + return (P3 Task 8)
 *
 * Verifies:
 *   1. adoptStations persists matrixId when the detected payload includes it.
 *   2. The returned row has matrixId set to the expected value.
 *   3. A station without matrixId in the payload → matrixId null in the stored row.
 *   4. listAdopted and getStation also return the matrixId field.
 *   5. Re-adopting a station updates its matrixId.
 *
 * Uses the local Docker test-postgres (localhost:5434).
 * DATABASE_URL must be set before any src/ modules are imported.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { test, expect, beforeAll, afterAll } from "bun:test";
import { rawSql } from "../db/drizzle";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { mintEnrollmentToken, enrollNode } from "./enrollment";
import { adoptStations, listAdopted, getStation, refreshAdoptedCapabilities } from "./station-registry";
import type { DetectedStation } from "@agentpod/contract";

// ─── Test Constants ────────────────────────────────────────────────────────────

const TEST_USER = "test-user-matrix-reg-001";

// nodeId is resolved after enrollment in beforeAll
let testNodeId = "";

// ─── Setup & Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: "matrix-reg-test@example.com",
    name: "Matrix Registry Test User",
  });

  // Enroll a test node so we have a valid nodeId to adopt stations under.
  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId } = await enrollNode(token, {
    hostname: "matrix-test-host",
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });
  testNodeId = nodeId;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations          WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM nodes             WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${TEST_USER}`;
    await rawSql`DELETE FROM "user"            WHERE id      = ${TEST_USER}`;
  } catch {
    // Ignore cleanup errors
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("adopt with matrixId → returned row has matrixId set", async () => {
  const MATRIX_ID = "@analyst-echo:id.agentpod.dev";

  const detected: DetectedStation[] = [
    {
      key: "station-with-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "Analyst Echo",
      parentKey: null,
      workspacePath: "/home/analyst",
      capabilities: ["health"],
      matrixId: MATRIX_ID,
      adopted: false,
    },
  ];

  const rows = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-with-matrix"],
    detected
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]!.matrixId).toBe(MATRIX_ID);
});

test("adopt without matrixId → returned row has matrixId null", async () => {
  const detected: DetectedStation[] = [
    {
      key: "station-without-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "No Matrix Agent",
      parentKey: null,
      workspacePath: null,
      capabilities: [],
      // matrixId intentionally omitted → undefined → null in DB
      adopted: false,
    },
  ];

  const rows = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-without-matrix"],
    detected
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]!.matrixId).toBeNull();
});

test("adopt with matrixId=null → returned row has matrixId null", async () => {
  const detected: DetectedStation[] = [
    {
      key: "station-explicit-null-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "Null Matrix Agent",
      parentKey: null,
      workspacePath: null,
      capabilities: [],
      matrixId: null,
      adopted: false,
    },
  ];

  const rows = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-explicit-null-matrix"],
    detected
  );

  expect(rows).toHaveLength(1);
  expect(rows[0]!.matrixId).toBeNull();
});

test("listAdopted returns matrixId in adopted rows", async () => {
  const MATRIX_ID = "@list-test-agent:id.agentpod.dev";

  const detected: DetectedStation[] = [
    {
      key: "station-list-matrix",
      harness: "opencode",
      kind: "leaf",
      displayName: "List Test Agent",
      parentKey: null,
      workspacePath: "/workspace",
      capabilities: ["health"],
      matrixId: MATRIX_ID,
      adopted: false,
    },
  ];

  await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-list-matrix"],
    detected
  );

  const allRows = await listAdopted(TEST_USER, testNodeId);
  const target = allRows.find((r) => r.stationKey === "station-list-matrix");
  expect(target).toBeDefined();
  expect(target!.matrixId).toBe(MATRIX_ID);
});

test("getStation returns matrixId for a specific station", async () => {
  const MATRIX_ID = "@get-test-agent:id.agentpod.dev";

  const detected: DetectedStation[] = [
    {
      key: "station-get-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "Get Test Agent",
      parentKey: null,
      workspacePath: null,
      capabilities: [],
      matrixId: MATRIX_ID,
      adopted: false,
    },
  ];

  const adoptedRows = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-get-matrix"],
    detected
  );

  expect(adoptedRows).toHaveLength(1);
  const stationId = adoptedRows[0]!.id;

  const fetched = await getStation(TEST_USER, stationId);
  expect(fetched).not.toBeNull();
  expect(fetched!.matrixId).toBe(MATRIX_ID);
});

test("re-adopting a station updates its matrixId", async () => {
  const INITIAL_MATRIX_ID = "@before:id.agentpod.dev";
  const UPDATED_MATRIX_ID = "@after:id.agentpod.dev";

  const detectedV1: DetectedStation[] = [
    {
      key: "station-update-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "Update Test Agent",
      parentKey: null,
      workspacePath: null,
      capabilities: [],
      matrixId: INITIAL_MATRIX_ID,
      adopted: false,
    },
  ];

  const rows1 = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-update-matrix"],
    detectedV1
  );
  expect(rows1[0]!.matrixId).toBe(INITIAL_MATRIX_ID);

  const detectedV2: DetectedStation[] = [
    {
      key: "station-update-matrix",
      harness: "hermes",
      kind: "leaf",
      displayName: "Update Test Agent",
      parentKey: null,
      workspacePath: null,
      capabilities: [],
      matrixId: UPDATED_MATRIX_ID,
      adopted: true,
    },
  ];

  const rows2 = await adoptStations(
    TEST_USER,
    testNodeId,
    ["station-update-matrix"],
    detectedV2
  );
  expect(rows2[0]!.matrixId).toBe(UPDATED_MATRIX_ID);
});

// ─── refreshAdoptedCapabilities ───────────────────────────────────────────────
//
// The bug these guard: `stations.capabilities` was written ONLY by
// adoptStations, so a station adopted before a capability existed could never
// gain it — the node reported it on every detect and the hub kept serving the
// row it stored at adoption. Any new capability hits this.

/** A detect fake in the shape brokerRequest returns. */
const detectReturning = (stations: unknown[]) =>
  async () => ({ ok: true as const, data: stations });

test("refresh updates capabilities on an already-adopted station", async () => {
  await adoptStations(TEST_USER, testNodeId, ["refresh-caps"], [
    {
      key: "refresh-caps", harness: "codex", kind: "leaf", displayName: "old name",
      parentKey: null, workspacePath: "/old", capabilities: ["health"], adopted: false,
    },
  ]);

  const updated = await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: detectReturning([
      {
        key: "refresh-caps", harness: "codex", kind: "leaf", displayName: "new name",
        parentKey: null, workspacePath: "/new", capabilities: ["health", "changeset"],
      },
    ]),
  });
  expect(updated).toBeGreaterThanOrEqual(1);

  const row = await getStation(TEST_USER, (await listAdopted(TEST_USER, testNodeId))
    .find((r) => r.stationKey === "refresh-caps")!.id);
  expect(row!.capabilities).toEqual(["health", "changeset"]);
  expect(row!.displayName).toBe("new name");
  expect(row!.workspacePath).toBe("/new");
});

test("refresh never adopts a station on its own", async () => {
  // Adoption stays an explicit act. If this ever inserts, every station a node
  // can see silently joins the fleet.
  await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: detectReturning([
      {
        key: "never-adopted-by-refresh", harness: "hermes", kind: "leaf", displayName: "nope",
        parentKey: null, workspacePath: null, capabilities: ["health", "changeset"],
      },
    ]),
  });

  const rows = await listAdopted(TEST_USER, testNodeId);
  expect(rows.find((r) => r.stationKey === "never-adopted-by-refresh")).toBeUndefined();
});

test("refresh is quiet when the node cannot answer", async () => {
  // Runs on every node connect. A node that fails detect must not throw into
  // the gateway's connect path.
  const updated = await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: async () => ({ ok: false as const, error: "node offline" }),
  });
  expect(updated).toBe(0);
});

test("refresh ignores a detect response that does not match the contract", async () => {
  const updated = await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: async () => ({ ok: true as const, data: { not: "an array" } }),
  });
  expect(updated).toBe(0);
});

test("refresh survives a broker that throws", async () => {
  const updated = await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: async () => { throw new Error("socket exploded"); },
  });
  expect(updated).toBe(0);
});

// ─── refreshAdoptedCapabilities: matrixId ─────────────────────────────────────
//
// The same bug as capabilities, one column over, and it survived the fix that
// found it. `stations.matrix_id` was written ONLY by adoptStations, so a station
// adopted before the mxid reader worked could never gain one. In production on
// 2026-08-15 that was every station: 32 adopted, 0 with a matrix_id, while
// `agentpod-node detect` on the same hosts reported
// "@buddhimaan:id.agentpod.dev" correctly and the contract carried it with
// tests. The node said it, the wire allowed it, and nothing wrote it down.
//
// It is on the critical path for the Matrix bridge: routing a room message to a
// station requires knowing which identity belongs to which station.

test("refresh writes a matrixId onto a station adopted without one", async () => {
  await adoptStations(TEST_USER, testNodeId, ["refresh-mxid"], [
    {
      key: "refresh-mxid", harness: "hermes", kind: "leaf", displayName: "olivia",
      parentKey: null, workspacePath: "/root/.hermes", capabilities: ["health"],
      adopted: false,
    },
  ]);

  await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: detectReturning([
      {
        key: "refresh-mxid", harness: "hermes", kind: "leaf", displayName: "olivia",
        parentKey: null, workspacePath: "/root/.hermes", capabilities: ["health"],
        matrixId: "@onboarding-olivia:id.agentpod.dev",
      },
    ]),
  });

  const row = await getStation(TEST_USER, (await listAdopted(TEST_USER, testNodeId))
    .find((r) => r.stationKey === "refresh-mxid")!.id);
  expect(row!.matrixId).toBe("@onboarding-olivia:id.agentpod.dev");
});

test("refresh clears a matrixId the node no longer reports", async () => {
  // An agent whose Matrix identity was removed must not keep a stale one: the
  // bridge would route to an mxid nobody answers on.
  await adoptStations(TEST_USER, testNodeId, ["refresh-mxid-gone"], [
    {
      key: "refresh-mxid-gone", harness: "hermes", kind: "leaf", displayName: "gone",
      parentKey: null, workspacePath: null, capabilities: ["health"],
      matrixId: "@stale:id.agentpod.dev", adopted: false,
    },
  ]);

  await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: detectReturning([
      {
        key: "refresh-mxid-gone", harness: "hermes", kind: "leaf", displayName: "gone",
        parentKey: null, workspacePath: null, capabilities: ["health"], matrixId: null,
      },
    ]),
  });

  const row = await getStation(TEST_USER, (await listAdopted(TEST_USER, testNodeId))
    .find((r) => r.stationKey === "refresh-mxid-gone")!.id);
  expect(row!.matrixId).toBeNull();
});

test("refresh leaves matrixId alone for a harness that reports none", async () => {
  // codex, opencode and pi have no Matrix identity at all — they are the
  // stations a bridge would mint a virtual user FOR. Absent must read as null,
  // never as an error.
  await adoptStations(TEST_USER, testNodeId, ["refresh-mxid-absent"], [
    {
      key: "refresh-mxid-absent", harness: "codex", kind: "leaf", displayName: "codex",
      parentKey: null, workspacePath: null, capabilities: ["health"], adopted: false,
    },
  ]);

  const updated = await refreshAdoptedCapabilities(testNodeId, {
    brokerRequest: detectReturning([
      {
        key: "refresh-mxid-absent", harness: "codex", kind: "leaf", displayName: "codex",
        parentKey: null, workspacePath: null, capabilities: ["health"],
      },
    ]),
  });

  expect(updated).toBeGreaterThanOrEqual(1);
  const row = await getStation(TEST_USER, (await listAdopted(TEST_USER, testNodeId))
    .find((r) => r.stationKey === "refresh-mxid-absent")!.id);
  expect(row!.matrixId).toBeNull();
});
