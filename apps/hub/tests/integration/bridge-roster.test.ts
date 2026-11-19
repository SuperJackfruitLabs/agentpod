/**
 * The bridge roster, as a table rather than an environment variable.
 *
 * What earns a test here is everything the env var could not check:
 *
 *   - a station that does not exist, or belongs to another tenant, cannot be named
 *   - the credentials go in encrypted and never come back out of the read surface
 *   - `hubUserId` is DERIVED from the station, so it cannot disagree with it
 *   - an edit moves `updatedAt`, which is what makes a running loop restart
 *
 * DATABASE_URL must point at the local Docker test-postgres on localhost:5434.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";
process.env.ENCRYPTION_KEY =
  process.env.ENCRYPTION_KEY || "bridge-roster-test-key-0123456789";

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { db } from "../../src/db/drizzle";
import { bridgeAgents } from "../../src/db/schema/bridge";
import { stations } from "../../src/db/schema/stations";
import { nodes } from "../../src/db/schema/nodes";
import { tenants, BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { fakePlane, fakePlaneJwks, signPlaneToken } from "../helpers/fake-plane";
import { setOrgPlaneClientForTests } from "../../src/auth/org-plane/client";
import { TEST_PLANE } from "../../src/auth/org-plane/config";
import { createTestUser } from "../helpers/database";
import {
  createBridgeAgent,
  deleteBridgeAgent,
  bridgePlaneCredential,
  listBridgeAgents,
  readBridgeRoster,
  updateBridgeAgent,
} from "../../src/services/bridge/roster";

const NODE_ID = "node_bridge_roster_test";
const STATION_ID = "station_bridge_roster_test";
const BOARD_ID = "brd_6a899b0f0d054046";
const TOKEN = `spa_${"a1b2c3d4".repeat(6)}`;
const MCP_TOKEN = `spa_${"f0e1d2c3".repeat(6)}`;

let userId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  userId = (await createTestUser({ name: "bridge-roster" })).id;

  await db
    .insert(nodes)
    .values({
      id: NODE_ID,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      name: "bridge-roster-node",
      hostname: "bridge-roster.test",
      os: "linux",
      arch: "arm64",
      status: "offline",
      secretHash: "x",
    })
    .onConflictDoNothing();

  await db
    .insert(stations)
    .values({
      id: STATION_ID,
      tenantId: BOOTSTRAP_TENANT_ID,
      userId,
      nodeId: NODE_ID,
      harness: "hermes",
      stationKey: "bridge-roster-station",
      kind: "service",
      displayName: "Roster Station",
    })
    .onConflictDoNothing();
});

beforeEach(async () => {
  await db
    .delete(bridgeAgents)
    .where(eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID));
});

afterAll(async () => {
  await db
    .delete(bridgeAgents)
    .where(eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID));
  await db.delete(stations).where(eq(stations.id, STATION_ID));
  await db.delete(nodes).where(eq(nodes.id, NODE_ID));
});

const base = () => ({
  tenantId: BOOTSTRAP_TENANT_ID,
  key: "coder-kai",
  boardId: BOARD_ID,
  stationId: STATION_ID,
  token: TOKEN,
  createdBy: userId,
});

describe("what the env var could never check", () => {
  test("a station that does not exist cannot be rostered", async () => {
    await expect(
      createBridgeAgent({ ...base(), stationId: "station_nope" }),
    ).rejects.toThrow();
  });

  test("a board id of the wrong grammar is refused by the database, not by a parser", async () => {
    // The env var was parsed by zod at boot; a typo there produced a hub that claimed nothing.
    await expect(
      createBridgeAgent({ ...base(), boardId: "brd_NOTHEX" }),
    ).rejects.toThrow();
  });

  test("a permission wait of zero is refused — it is not a policy, it is a bug", async () => {
    await expect(
      createBridgeAgent({ ...base(), permissionWaitMs: 0 }),
    ).rejects.toThrow();
  });

  test("two agents cannot share a key within a tenant", async () => {
    await createBridgeAgent(base());
    await expect(createBridgeAgent(base())).rejects.toThrow();
  });
});

describe("the credentials", () => {
  test("go in encrypted — the plaintext is not in the row", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const [row] = await db
      .select()
      .from(bridgeAgents)
      .where(
        and(
          eq(bridgeAgents.tenantId, BOOTSTRAP_TENANT_ID),
          eq(bridgeAgents.key, "coder-kai"),
        ),
      );

    expect(row!.tokenEncrypted).not.toContain(TOKEN);
    expect(row!.mcpTokenEncrypted).not.toContain(MCP_TOKEN);
    expect(row!.tokenEncrypted.length).toBeGreaterThan(0);
  });

  test("never come back out of the read surface — only whether they are set", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const listed = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      key: "coder-kai",
      hasToken: true,
      hasMcpToken: true,
    });
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(JSON.stringify(listed)).not.toContain(MCP_TOKEN);
  });

  test("an agent with no mcpToken reports so, rather than reporting an empty one", async () => {
    await createBridgeAgent(base());
    const [listed] = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed!.hasMcpToken).toBe(false);
  });

  test("come back decrypted for the bridge itself, which is the one caller that needs them", async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });

    const roster = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(roster).toHaveLength(1);
    expect(roster[0]!.token).toBe(TOKEN);
    expect(roster[0]!.mcpToken).toBe(MCP_TOKEN);
  });
});

describe("hubUserId is derived, so it cannot disagree with the station", () => {
  test("the roster reads the session owner off the station", async () => {
    await createBridgeAgent(base());
    const [agent] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    // The session is the station adopter's (sessions stay a person's own, W4); a stored value
    // could disagree with the station, which is why it is not a stored field.
    expect(agent!.hubUserId).toBe(userId);
  });

  test("there is no way to set it — the create surface does not take one", async () => {
    await createBridgeAgent({
      ...base(),
      hubUserId: "usr_someone_else",
    } as never);
    const [agent] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(agent!.hubUserId).toBe(userId);
  });
});

describe("what the reconciler reads", () => {
  test("a disabled agent is absent from the roster but present in the list", async () => {
    await createBridgeAgent(base());
    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
      enabled: false,
    });

    expect(await readBridgeRoster(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
    // Still visible to a human: disabling is not deleting, and the credential is still there.
    const listed = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ enabled: false, hasToken: true });
  });

  test("an edit changes the revision — which is the whole signal a loop restarts on", async () => {
    await createBridgeAgent(base());
    const before = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;

    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { mode: "ask" });

    const after = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!;
    expect(after.mode).toBe("ask");
    expect(after.revision).not.toBe(before);
  });

  test("rotating a token changes it too, so the running loop picks the new one up", async () => {
    await createBridgeAgent(base());
    const before = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;

    const rotated = `spa_${"9876543a".repeat(6)}`;
    await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
      token: rotated,
    });

    const after = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!;
    expect(after.token).toBe(rotated);
    expect(after.revision).not.toBe(before);
  });

  test("reading twice without an edit gives the same revision — it is not a nonce", async () => {
    // A digest that changed on every read would restart every loop on every tick.
    await createBridgeAgent(base());
    const a = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;
    const b = (await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]!.revision;
    expect(a).toBe(b);
  });

  test("deleting one removes it", async () => {
    await createBridgeAgent(base());
    await deleteBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai");
    expect(await listBridgeAgents(BOOTSTRAP_TENANT_ID)).toHaveLength(0);
  });
});

describe("the roster is tenant-scoped, which the env var had no way to be", () => {
  test("a read for another tenant sees nothing", async () => {
    await createBridgeAgent(base());
    expect(await readBridgeRoster("fleet_ffffffffffffffffffff")).toHaveLength(
      0,
    );
    expect(await listBridgeAgents("fleet_ffffffffffffffffffff")).toHaveLength(
      0,
    );
  });
});

const PRINCIPAL = "prn_12345678901234567890";
const ORGANIZATION = "org_12345678901234567890";
const PRODUCTION = "https://app.superpipeline.dev";
const STAGING = "https://staging-app.superpipeline.dev";
const sourceFor = (audience: string) => ({
  version: 1 as const,
  kind: "station-plane" as const,
  principalId: PRINCIPAL,
  organizationId: ORGANIZATION,
  audience,
});

/** The occupant's plane record, for a test to change. */
function occupant() {
  const p = fakePlane.principals.get(PRINCIPAL);
  if (!p) throw Error("fixture occupant missing");
  return p;
}

/** Map the tenant to an organization and seat the principal in a Salaam station, then restore. */
async function withSalaamBinding(
  superpipeline: string | undefined,
  body: () => Promise<void>,
  harness = "salaam",
) {
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.id, BOOTSTRAP_TENANT_ID));
  if (!tenant) throw Error("fixture tenant missing");
  const priorSuperpipeline = process.env.SUPERPIPELINE_BASE_URL;
  if (superpipeline === undefined) delete process.env.SUPERPIPELINE_BASE_URL;
  else process.env.SUPERPIPELINE_BASE_URL = superpipeline;
  await db
    .update(tenants)
    .set({ externalSource: "org-plane", externalId: ORGANIZATION })
    .where(eq(tenants.id, BOOTSTRAP_TENANT_ID));
  await db
    .update(stations)
    .set({ harness, principalId: PRINCIPAL })
    .where(eq(stations.id, STATION_ID));
  // The occupant as the organization plane knows it: an agent in the workspace's organization.
  fakePlane.addAgent({ id: PRINCIPAL });
  occupant().organizationId = ORGANIZATION;
  try {
    await body();
  } finally {
    fakePlane.remove(PRINCIPAL);
    if (priorSuperpipeline === undefined)
      delete process.env.SUPERPIPELINE_BASE_URL;
    else process.env.SUPERPIPELINE_BASE_URL = priorSuperpipeline;
    await db
      .update(stations)
      .set({ harness: "hermes", principalId: null })
      .where(eq(stations.id, STATION_ID));
    await db
      .update(tenants)
      .set({
        externalSource: tenant.externalSource,
        externalId: tenant.externalId,
      })
      .where(eq(tenants.id, BOOTSTRAP_TENANT_ID));
  }
}

test("station-plane roster stores binding only, rejects drift and can always disable", async () => {
  const source = sourceFor(PRODUCTION);
  await withSalaamBinding(PRODUCTION, async () => {
    await expect(
      createBridgeAgent({ ...base(), credentialSource: source }),
    ).rejects.toThrow("cannot store tokens");
    await createBridgeAgent({
      ...base(),
      token: undefined,
      credentialSource: source,
    });
    const [row] = await db
      .select()
      .from(bridgeAgents)
      .where(eq(bridgeAgents.key, "coder-kai"));
    if (!row) throw Error("fixture roster row missing");
    expect(row.tokenEncrypted).toBe("");
    expect(row.mcpTokenEncrypted).toBeNull();
    expect(row.credentialSource).toEqual(source);
    const [view] = await listBridgeAgents(BOOTSTRAP_TENANT_ID);
    if (!view) throw Error("fixture roster view missing");
    expect(view.hasToken).toBe(false);
    const [secret] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    if (!secret) throw Error("fixture roster secret missing");
    expect(secret.token).toBe("");
    expect(secret.credentialSource).toEqual(source);
    await expect(
      updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { token: TOKEN }),
    ).rejects.toThrow();
    await expect(
      updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
        credentialSource: null,
      }),
    ).rejects.toThrow();
    await db
      .update(stations)
      .set({ principalId: "prn_ffffffffffffffffffff" })
      .where(eq(stations.id, STATION_ID));
    await expect(
      updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { enabled: true }),
    ).rejects.toThrow();
    expect(
      await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
        enabled: false,
      }),
    ).toBe(true);
    expect(
      await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
        credentialSource: null,
        token: TOKEN,
      }),
    ).toBe(true);
  });
});

describe("a credential source names this deployment's SuperPipeline audience, and no other", () => {
  test("a staging hub admits the staging audience and refuses production's", async () => {
    await withSalaamBinding(`${STAGING}/`, async () => {
      await expect(
        createBridgeAgent({
          ...base(),
          token: undefined,
          credentialSource: sourceFor(PRODUCTION),
        }),
      ).rejects.toThrow(`this deployment's SuperPipeline audience, ${STAGING}`);
      await createBridgeAgent({
        ...base(),
        token: undefined,
        credentialSource: sourceFor(STAGING),
      });
      const [secret] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
      expect(secret?.credentialSource).toEqual(sourceFor(STAGING));
    });
  });

  test("a hub with no SuperPipeline configured admits no source", async () => {
    await withSalaamBinding(undefined, async () => {
      await expect(
        createBridgeAgent({
          ...base(),
          token: undefined,
          credentialSource: sourceFor(PRODUCTION),
        }),
      ).rejects.toThrow("admits no station-plane credential source");
    });
  });

  test("a stored source for another deployment is never read as spendable", async () => {
    const unreadable: string[] = [];
    await withSalaamBinding(PRODUCTION, async () => {
      await createBridgeAgent({
        ...base(),
        token: undefined,
        credentialSource: sourceFor(PRODUCTION),
      });
      process.env.SUPERPIPELINE_BASE_URL = STAGING;
      expect(
        await readBridgeRoster(BOOTSTRAP_TENANT_ID, (key) =>
          unreadable.push(key),
        ),
      ).toHaveLength(0);
    });
    expect(unreadable).toEqual(["coder-kai"]);
  });
});

test("a legacy token row upgrades in place to a credential source, and the token goes", async () => {
  await withSalaamBinding(STAGING, async () => {
    await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });
    // The deployment's audience only: a production source on a staging hub leaves the row alone.
    await expect(
      updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
        credentialSource: sourceFor(PRODUCTION),
      }),
    ).rejects.toThrow("SuperPipeline audience");
    const [unchanged] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(unchanged?.token).toBe(TOKEN);
    expect(unchanged?.credentialSource).toBeNull();

    expect(
      await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", {
        credentialSource: sourceFor(STAGING),
      }),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(bridgeAgents)
      .where(eq(bridgeAgents.key, "coder-kai"));
    expect(row?.credentialSource).toEqual(sourceFor(STAGING));
    expect(row?.tokenEncrypted).toBe("");
    expect(row?.mcpTokenEncrypted).toBeNull();
    const [secret] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
    expect(secret?.token).toBe("");
    expect(secret?.mcpToken).toBeNull();
    expect(secret?.credentialSource).toEqual(sourceFor(STAGING));
  });
});

describe("a station-plane source is the occupant's identity, whatever the harness", () => {
  const create = () =>
    createBridgeAgent({ ...base(), token: undefined, credentialSource: sourceFor(PRODUCTION) });

  test("a hermes station whose occupant is an agent of the mapped organization is admitted", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      await create();
      const [secret] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
      expect(secret?.credentialSource).toEqual(sourceFor(PRODUCTION));
      expect(secret?.token).toBe("");
    }, "hermes");
  });

  test("a legacy hermes row upgrades in place", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      await createBridgeAgent({ ...base(), mcpToken: MCP_TOKEN });
      expect(
        await updateBridgeAgent(BOOTSTRAP_TENANT_ID, "coder-kai", { credentialSource: sourceFor(PRODUCTION) }),
      ).toBe(true);
      expect((await readBridgeRoster(BOOTSTRAP_TENANT_ID))[0]?.credentialSource).toEqual(sourceFor(PRODUCTION));
    }, "hermes");
  });

  test("a hermes row's source is spent: the exchange runs and the binding check passes", async () => {
    const restorePlane = setOrgPlaneClientForTests({
      ...fakePlane,
      agentToken: async (principal, audience) => ({
        expiresIn: 300,
        accessToken: await signPlaneToken({ sub: principal, principalKind: "agent", aud: audience,
          ent: ["superpipeline"], scope: "claim", org: ORGANIZATION }),
      }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      return address === TEST_PLANE.jwksUrl ? Response.json(await fakePlaneJwks()) : realFetch(url, init);
    }, { preconnect: realFetch.preconnect });
    try {
      await withSalaamBinding(PRODUCTION, async () => {
        await create();
        const [secret] = await readBridgeRoster(BOOTSTRAP_TENANT_ID);
        if (!secret) throw Error("fixture roster secret missing");
        expect(typeof (await bridgePlaneCredential(secret)())).toBe("string");
      }, "hermes");
    } finally {
      globalThis.fetch = realFetch;
      restorePlane();
    }
  });

  test("an occupant that is not an agent principal is refused", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      occupant().kind = "human";
      await expect(create()).rejects.toThrow("the occupant is a human principal, not an agent");
    }, "hermes");
  });

  test("an occupant the plane places in another organization is refused", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      occupant().organizationId = "org_ffffffffffffffffffff";
      await expect(create()).rejects.toThrow("the occupant belongs to another organization");
    }, "hermes");
  });

  test("a source naming another organization than the workspace's is refused", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      await expect(
        createBridgeAgent({
          ...base(),
          token: undefined,
          credentialSource: { ...sourceFor(PRODUCTION), organizationId: "org_ffffffffffffffffffff" },
        }),
      ).rejects.toThrow("the organization is not this workspace's");
    }, "hermes");
  });

  test("a source naming someone other than the station's occupant is refused", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      await expect(
        createBridgeAgent({
          ...base(),
          token: undefined,
          credentialSource: { ...sourceFor(PRODUCTION), principalId: "prn_ffffffffffffffffffff" },
        }),
      ).rejects.toThrow("the principal is not this station's occupant");
    }, "hermes");
  });

  test("a suspended or unknown occupant is refused", async () => {
    await withSalaamBinding(PRODUCTION, async () => {
      occupant().suspended = true;
      await expect(create()).rejects.toThrow("the occupant is suspended");
      fakePlane.remove(PRINCIPAL);
      await expect(create()).rejects.toThrow("not a principal at the organization plane");
    }, "hermes");
  });
});
