import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { rawSql } from "../../src/db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { createPrincipal } from "../../src/services/principals";
import { provisionStation } from "../../src/services/matrix-as/provision";

/**
 * Item 9, steps 2-3 (operator approval 2026-10-30): a Salaam station's Matrix name and face come
 * from the persona its host manifest pins, and change when that persona changes. A profile that
 * has not changed is not re-read or re-uploaded at every boot.
 */
const DOMAIN = "id.agentpod.dev";
const OWNER = "test-user-mx-persona";
const NODE = "node_mx_persona";
const SALAAM = "station_mx_persona_salaam";
const HANDLE = "mx-persona-scribe";
const MXID = `@agent_${HANDLE}:${DOMAIN}`;

let registered: Array<{ localpart: string; displayName: string }> = [];
let uploaded: Array<{ bytes: number }> = [];
let faces: Record<string, string> = {};
let files: Record<string, { bytes: Uint8Array; contentType: string } | null> = {};
let persona: { digest: string; text: string } | null = null;
let personaReads = 0;

const png = (n: number) => ({ bytes: new Uint8Array(n), contentType: "image/png" });

function deps() {
  return {
    domain: DOMAIN,
    client: {
      ensureUser: async (localpart: string, displayName: string) => {
        registered.push({ localpart, displayName });
      },
      ensureRoom: async () => "!persona:id.agentpod.dev",
      invite: async () => {},
      uploadImage: async (_u: string, bytes: Uint8Array) => {
        uploaded.push({ bytes: bytes.length });
        return `mxc://${DOMAIN}/face${uploaded.length}`;
      },
      setAvatar: async (userId: string, mxc: string) => {
        faces[userId] = mxc;
      },
      getAvatar: async (userId: string) => faces[userId] ?? null,
    },
    readWorkspaceFile: async (_s: string, path: string) => files[path] ?? null,
    readPersona: async () => {
      personaReads++;
      return persona;
    },
  };
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: "mx-persona@example.com", name: "Owner" });
  const agent = await createPrincipal({ kind: "agent", handle: HANDLE });
  await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${SALAAM}`;
  await rawSql`DELETE FROM stations WHERE id = ${SALAAM}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, 'persona-box', 'persona-box', 'linux', 'amd64', 2, 'online', 'x', now())`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${SALAAM}, ${BOOTSTRAP_TENANT_ID}, ${OWNER}, ${NODE}, 'salaam', 'salaam:scribe', 'leaf', 'scribe',
            '["acp"]'::jsonb, ${agent}, now(), now())`;
});

beforeEach(async () => {
  registered = [];
  uploaded = [];
  faces = {};
  files = {};
  persona = null;
  personaReads = 0;
  await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${SALAAM}`;
  await rawSql`UPDATE stations SET matrix_profile_key = NULL WHERE id = ${SALAAM}`;
});

afterAll(async () => {
  try {
    await rawSql`DELETE FROM matrix_rooms WHERE station_id = ${SALAAM}`;
    await rawSql`DELETE FROM stations WHERE id = ${SALAAM}`;
    await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
    await rawSql`DELETE FROM principals WHERE handle = ${HANDLE}`;
    await deleteTestUser(OWNER);
  } catch {
    // cleanup only
  }
});

describe("a Salaam station's Matrix profile comes from its persona", () => {
  test("the persona's declared name is the display name", async () => {
    persona = { digest: "d1", text: "name: Ada\nYou help." };
    await provisionStation(SALAAM, deps());
    expect(registered.at(-1)!.displayName).toBe("Ada (salaam @ persona-box)");
  });

  test("with no persona the station's own name stays", async () => {
    await provisionStation(SALAAM, deps());
    expect(registered.at(-1)!.displayName).toBe("scribe (salaam @ persona-box)");
  });

  test("the persona's avatar path is the face, before the usual candidates", async () => {
    files["pfp.png"] = png(4);
    files["brand/ada.png"] = png(9);
    persona = { digest: "d1", text: "name: Ada\navatar: brand/ada.png" };
    await provisionStation(SALAAM, deps());
    expect(uploaded).toEqual([{ bytes: 9 }]);
    expect(faces[MXID]).toBe(`mxc://${DOMAIN}/face1`);
  });

  test("an unchanged profile is not re-uploaded at the next boot", async () => {
    files["brand/ada.png"] = png(9);
    persona = { digest: "d1", text: "name: Ada\navatar: brand/ada.png" };
    await provisionStation(SALAAM, deps());
    await provisionStation(SALAAM, deps());
    expect(uploaded).toHaveLength(1);
    const [row] = await rawSql`SELECT matrix_profile_key FROM stations WHERE id = ${SALAAM}`;
    expect(row!.matrix_profile_key).toMatch(/^[a-f0-9]{64}$/);
  });

  test("a changed persona refreshes the face, though the identity already has one", async () => {
    files["brand/ada.png"] = png(9);
    files["brand/ada-2.png"] = png(12);
    persona = { digest: "d1", text: "name: Ada\navatar: brand/ada.png" };
    await provisionStation(SALAAM, deps());
    persona = { digest: "d2", text: "name: Ada II\navatar: brand/ada-2.png" };
    await provisionStation(SALAAM, deps());
    expect(uploaded).toEqual([{ bytes: 9 }, { bytes: 12 }]);
    expect(registered.at(-1)!.displayName).toBe("Ada II (salaam @ persona-box)");
    expect(faces[MXID]).toBe(`mxc://${DOMAIN}/face2`);
  });

  test("a persona that cannot be read does not cost the station its room or name", async () => {
    const d = deps();
    await provisionStation(SALAAM, {
      ...d,
      readPersona: async () => {
        throw new Error("node offline");
      },
    });
    expect(registered.at(-1)!.displayName).toBe("scribe (salaam @ persona-box)");
  });
});
