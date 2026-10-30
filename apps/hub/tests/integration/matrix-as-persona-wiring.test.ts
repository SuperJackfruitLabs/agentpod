import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { createPrincipal } from "../../src/services/principals";
import { connectionManager } from "../../src/services/connection-manager";
import { handleNodeMessage } from "../../src/services/broker";
import { createMatrixBridge, matrixBridgeConfig } from "../../src/services/matrix-as";
import { provisionStation } from "../../src/services/matrix-as/provision";
import { onStationsAdopted } from "../../src/services/matrix-as/hooks";
import { announceStationsForNode } from "../../src/services/station-registry";

/**
 * Item 9 live gap (staging, hub 34aac256): the node reported the new persona, but the station's
 * Matrix profile never changed. These tests go through the real wiring — the bridge's own
 * readPersona over the real broker, and the node-connect announcement — with only the node's
 * socket and the homeserver faked, answering in the node's real config.observe shape.
 */
const DOMAIN = "id.agentpod.dev";
const OWNER = "test-user-mx-wiring";
const NODE = "node_mx_wiring";
const SALAAM = "station_mx_wiring_salaam";
const OTHER = "station_mx_wiring_hermes";
const HANDLE = "mx-wiring-scribe";
const OTHER_HANDLE = "mx-wiring-hermes";

let persona: { digest: string; text: string } | null = null;
let observes: Array<{ stationKey: string }> = [];
/** How many config.observe calls the node refuses first, as a just-restarted node does. */
let notReadyFor = 0;
let uploads = 0;

function answerAsNode() {
  connectionManager.register(NODE, (m: any) => {
    if (m?.type !== "req") return;
    queueMicrotask(() => {
      if (m.verb === "config.observe") {
        observes.push({ stationKey: m.params.stationKey });
        if (notReadyFor > 0) {
          notReadyFor--;
          handleNodeMessage(NODE, { type: "res", id: m.id, ok: false, error: "station not ready" } as any);
          return;
        }
        handleNodeMessage(NODE, {
          type: "res",
          id: m.id,
          ok: true,
          data: {
            values: [
              persona
                ? { settingId: "salaam.persona", observed: persona, readable: true }
                : { settingId: "salaam.persona", readable: true },
            ],
          },
        } as any);
      } else {
        handleNodeMessage(NODE, { type: "res", id: m.id, ok: false, error: "unsupported" } as any);
      }
    });
  });
}

const bridge = createMatrixBridge(
  matrixBridgeConfig({
    ENABLE_MATRIX_BRIDGE: "true",
    MATRIX_HOMESERVER_URL: "http://127.0.0.1:6167",
    MATRIX_SERVER_NAME: DOMAIN,
    MATRIX_AS_TOKEN: "as-token",
    MATRIX_HS_TOKEN: "hs-token",
  } as unknown as NodeJS.ProcessEnv),
)!;

let registered: Array<{ localpart: string; displayName: string }> = [];
function deps() {
  return {
    ...bridge.provisionDeps,
    client: {
      ensureUser: async (localpart: string, displayName: string) => {
        registered.push({ localpart, displayName });
      },
      ensureRoom: async () => "!wiring:id.agentpod.dev",
      invite: async () => {},
      getAvatar: async () => "mxc://x/y",
      uploadImage: async () => {
        uploads++;
        return "mxc://x/new";
      },
      setAvatar: async () => {},
    },
    readWorkspaceFile: async () => ({ bytes: new Uint8Array(4), contentType: "image/png" }),
  } as any;
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "mx-wiring@example.com", name: "Owner" });
  const agent = await createPrincipal({ kind: "agent", handle: HANDLE });
  const other = await createPrincipal({ kind: "agent", handle: OTHER_HANDLE });
  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${SALAAM}, ${OTHER})`;
  await rawSql`DELETE FROM stations WHERE id IN (${SALAAM}, ${OTHER})`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, 'wiring-box', 'wiring-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${SALAAM}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, ${NODE}, 'salaam', 'salaam:scribe', 'leaf', 'scribe', '["acp"]'::jsonb, ${agent}, now(), now()),
           (${OTHER}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, ${NODE}, 'hermes', 'hermes:hermy', 'leaf', 'hermy', '["acp"]'::jsonb, ${other}, now(), now())`;
});

beforeEach(async () => {
  persona = null;
  observes = [];
  registered = [];
  notReadyFor = 0;
  uploads = 0;
  connectionManager.unregister(NODE);
  await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${SALAAM}, ${OTHER})`;
  await rawSql`UPDATE stations SET matrix_profile_key = NULL WHERE id IN (${SALAAM}, ${OTHER})`;
});

afterAll(async () => {
  onStationsAdopted(null);
  connectionManager.unregister(NODE);
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE station_id IN (${SALAAM}, ${OTHER})`;
    await rawSql`DELETE FROM stations WHERE id IN (${SALAAM}, ${OTHER})`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM principals WHERE handle IN (${HANDLE}, ${OTHER_HANDLE})`;
    await deleteTestUser(OWNER);
  } catch {
    // cleanup only
  }
});

describe("the bridge reads a Salaam persona through its node", () => {
  test("readPersona returns the persona the node reports, in the node's real shape", async () => {
    answerAsNode();
    persona = { digest: "9d6e", text: "name: Staging Researcher\nYou help." };
    const got = await bridge.provisionDeps.readPersona!(SALAAM);
    expect(observes).toEqual([{ stationKey: "salaam:scribe" }]);
    expect(got).toEqual(persona);
  });

  test("a persona the node cannot read yet does not settle the profile; the next pass names the station", async () => {
    // Staging, hub 34aac256: the reconnect pass ran three seconds after the node dialled in, the
    // node could not answer yet, and the fallback name was recorded as if it were the answer.
    answerAsNode();
    persona = { digest: "9d6e", text: "name: Staging Researcher\nYou help." };
    notReadyFor = 1;
    await provisionStation(SALAAM, deps());
    expect(registered.at(-1)!.displayName).toBe("scribe (salaam @ wiring-box)");
    const [unread] = await rawSql`SELECT matrix_profile_key FROM stations WHERE id = ${SALAAM}`;
    expect(unread!.matrix_profile_key).toBeNull();
    expect(uploads).toBe(0);
    await provisionStation(SALAAM, deps());
    expect(registered.at(-1)!.displayName).toBe("Staging Researcher (salaam @ wiring-box)");
    const [read] = await rawSql`SELECT matrix_profile_key FROM stations WHERE id = ${SALAAM}`;
    expect(read!.matrix_profile_key).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a node with no persona settles the fallback, and an unchanged persona is not re-uploaded", async () => {
    answerAsNode();
    await provisionStation(SALAAM, deps());
    const [none] = await rawSql`SELECT matrix_profile_key FROM stations WHERE id = ${SALAAM}`;
    expect(none!.matrix_profile_key).toMatch(/^[a-f0-9]{64}$/);
    persona = { digest: "9d6e", text: "name: Staging Researcher" };
    await provisionStation(SALAAM, deps());
    const after = uploads;
    await provisionStation(SALAAM, deps());
    expect(uploads).toBe(after);
  });

  test("a node that dials in is asked again later, so a station it could not answer for converges", async () => {
    answerAsNode();
    persona = { digest: "9d6e", text: "name: Staging Researcher\nYou help." };
    notReadyFor = 1;
    onStationsAdopted(async (ids) => {
      for (const id of ids) await provisionStation(id, deps());
    });
    const { CONNECT_ANNOUNCE_DELAYS_MS } = await import("../../src/routes/gateway");
    expect(CONNECT_ANNOUNCE_DELAYS_MS.length).toBeGreaterThan(1);
    for (const _ of CONNECT_ANNOUNCE_DELAYS_MS) {
      await announceStationsForNode(NODE);
      await new Promise((r) => setTimeout(r, 50));
    }
    const names = registered.filter((r) => r.localpart === `agent_${HANDLE}`).map((r) => r.displayName);
    expect(names.at(-1)).toBe("Staging Researcher (salaam @ wiring-box)");
    // A station of another harness is never asked for a Salaam persona.
    expect(observes.every((o) => o.stationKey === "salaam:scribe")).toBe(true);
    onStationsAdopted(null);
  });
});
