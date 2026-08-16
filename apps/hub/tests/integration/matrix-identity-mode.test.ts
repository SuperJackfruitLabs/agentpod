import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { refreshAdoptedCapabilities } from "../../src/services/station-registry";

/**
 * Two facts about one station, and who answers.
 *
 * `matrix_id` is what the HARNESS reports — the node agent reads it off the host
 * and owns it outright. `bridge_matrix_id` is what the Application Service
 * MINTED for a station whose harness knows nothing about Matrix.
 *
 * An earlier draft kept both in `matrix_id` and guarded the column against its
 * own writer. That broke a fix this repo already paid for: a station adopted
 * before its profile was readable could no longer gain an identity later. Two
 * facts, two columns; `matrix_identity_mode` says which one answers, and never
 * both — two answerers on one address is the failure being prevented.
 */

const USER = "test-user-matrix-mode";
const NODE = "node_matrix_mode";
const BRIDGED = "station_matrix_mode_bridged";
const HARNESS = "station_matrix_mode_harness";

async function stationRow(id: string) {
  const [row] = await rawSql`
    SELECT matrix_id, bridge_matrix_id, matrix_identity_mode FROM stations WHERE id = ${id}`;
  return row!;
}

/**
 * Drive the refresh with what the node agent would have reported, through the
 * broker injection point the function already exposes — no live node needed.
 */
async function nodeReports(reported: Array<{ key: string; matrixId: string | null }>) {
  return refreshAdoptedCapabilities(NODE, {
    brokerRequest: async () => ({
      ok: true,
      data: reported.map((s) => ({
        key: s.key,
        harness: "hermes",
        kind: "leaf" as const,
        displayName: s.key,
        parentKey: null,
        workspacePath: null,
        capabilities: ["acp"],
        matrixId: s.matrixId,
      })),
    }),
  });
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: USER, email: "matrix-mode@example.com", name: "MM" });
  const tenant = await resolveTenantForUser(USER);
  await rawSql`DELETE FROM stations WHERE id IN (${BRIDGED}, ${HARNESS})`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${USER}, 'mode-box', 'mode-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  for (const [id, key] of [[BRIDGED, "hermes:bridged"], [HARNESS, "hermes:harness"]] as const) {
    await rawSql`
      INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, adopted_at, created_at)
      VALUES (${id}, ${tenant}, ${USER}, ${NODE}, 'hermes', ${key}, 'leaf', ${key}, '["acp"]'::jsonb, now(), now())`;
  }
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM stations WHERE id IN (${BRIDGED}, ${HARNESS})`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM "user" WHERE id = ${USER}`;
  } catch {
    // cleanup only
  }
});

describe("matrix_identity_mode", () => {
  test("defaults to bridge, which is the mode with no credential anywhere", () => {
    // A station only becomes `harness` when somebody deliberately issues it
    // credentials. Defaulting the other way would mean a new station arrives
    // claiming to answer for itself, with nothing able to answer.
    return stationRow(BRIDGED).then((row) => {
      expect(row.matrix_identity_mode).toBe("bridge");
    });
  });

  test("refuses a mode that is neither", async () => {
    let refused: unknown = null;
    try {
      await rawSql`UPDATE stations SET matrix_identity_mode = 'sometimes' WHERE id = ${BRIDGED}`;
    } catch (e) {
      refused = e;
    }
    expect(refused).not.toBeNull();
  });

  test("a node-agent refresh cannot touch the identity the bridge minted", async () => {
    // The point of the second column. The node agent reports `matrixId: null`
    // for a station whose harness knows nothing about Matrix — and no report it
    // can make may erase what the Application Service minted.
    await rawSql`
      UPDATE stations SET bridge_matrix_id = '@agent_mode-box_hermes-bridged:id.agentpod.dev',
                          matrix_identity_mode = 'bridge'
      WHERE id = ${BRIDGED}`;

    await nodeReports([{ key: "hermes:bridged", matrixId: null }]);

    const row = await stationRow(BRIDGED);
    expect(row.bridge_matrix_id).toBe("@agent_mode-box_hermes-bridged:id.agentpod.dev");
    expect(row.matrix_identity_mode).toBe("bridge");
  });

  test("a bridge-owned station still gets its capabilities refreshed", async () => {
    // Nothing about the mode may narrow what the node agent refreshes.
    // Gating the row would stop capabilities, display name and workspace path
    // landing for every bridge-mode station — the defect that once left 32
    // stations stale, one column over.
    await rawSql`
      UPDATE stations SET capabilities = '["acp"]'::jsonb, display_name = 'stale',
                          matrix_identity_mode = 'bridge'
      WHERE id = ${BRIDGED}`;


    await nodeReports([{ key: "hermes:bridged", matrixId: null }]);

    const [row] = await rawSql`
      SELECT display_name, capabilities FROM stations WHERE id = ${BRIDGED}`;
    expect(row!.display_name).toBe("hermes:bridged");
  });

  test("the harness-reported mxid is refreshed however the station answers", async () => {
    // The node agent owns `matrix_id` outright, in either mode. What the mode
    // decides is who answers — not who may write down what the host says.
    await rawSql`
      UPDATE stations SET matrix_id = '@old:id.agentpod.dev', matrix_identity_mode = 'harness'
      WHERE id = ${HARNESS}`;

    await nodeReports([{ key: "hermes:harness", matrixId: "@new:id.agentpod.dev" }]);

    expect((await stationRow(HARNESS)).matrix_id).toBe("@new:id.agentpod.dev");
  });

  test("a station that loses its harness identity on the host loses it here", async () => {
    // `?? null` rather than skip-if-absent, unchanged for harness mode: an
    // agent whose Matrix identity was removed must lose it here too, or a room
    // message routes to an mxid nobody answers on.
    await rawSql`
      UPDATE stations SET matrix_id = '@present:id.agentpod.dev', matrix_identity_mode = 'harness'
      WHERE id = ${HARNESS}`;

    await nodeReports([{ key: "hermes:harness", matrixId: null }]);

    expect((await stationRow(HARNESS)).matrix_id).toBeNull();
  });
});
