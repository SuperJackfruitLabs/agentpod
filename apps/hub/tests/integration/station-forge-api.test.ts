/**
 * The forge API grant lifecycle, minted mode: grant → mint → seal → deliver.
 *
 * The hardest assertions are about what must NOT happen: the minted token appearing anywhere (logs,
 * audit rows, grant rows, thrown errors, broker frames), a token minted before the hub knows it can
 * reach the station, a delivery attempted before the token handle is persisted, a grant marked
 * `delivered` without a positive acknowledgement, and a frame reaching the broker unvalidated.
 *
 * The broker and provider are stubs injected through `deps`; the sealer is the real one (libsodium,
 * Bun >= 1.4.2) except where a test makes it fail.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import handoverFixture from "../../../../packages/contract/fixtures/handover-v1.json";

import { db, rawSql } from "../../src/db/drizzle";
import { stationForgeApiGrants as g, type StationForgeApiGrant as Grant, type StationForgeApiGrant } from "../../src/db/schema/forge-api-grants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { pollUntil } from "../helpers/wait";
import postgres from "postgres";
import { createTestUser } from "../helpers/database";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { getProvider, type ForgeProvider } from "../../src/services/forge-api/providers";
import { sealHandover } from "../../src/services/handover-seal";
import {
  createForgeApiGrant,
  deliverGrant,
  transition,
  ForgeApiGrantError,
  CLAIM_CAP,
  POOL_RESERVE,
  claimFaults,
  type ForgeApiDeps,
} from "../../src/services/station-forge-api";
import { BOOTSTRAP_TENANT_ID } from "../../src/db/schema/tenants";

const RUN = crypto.randomUUID().slice(0, 8);
const OWNER = `test-user-sfa-${RUN}`;
const NODE = `node_sfa_${RUN}`;
const FORGE = "https://forge.sfa.test";
const PUBLIC_KEY = (handoverFixture as { public_key: string }).public_key;
const DAY = 24 * 60 * 60 * 1000;

let tenant: string;
let seq = 0;
const handles: string[] = [];

/** A real-looking forge token: 40 hex chars, fresh per test. */
const newSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

async function freshStation(opts: { occupied?: boolean; caps?: string[] } = {}) {
  const id = `station_sfa_${RUN}_${seq++}`;
  let principalId: string | null = null;
  let handle: string | null = null;
  if (opts.occupied !== false) {
    handle = `sfa-agent-${RUN}-${seq}`;
    handles.push(handle);
    principalId = await createPrincipal({ kind: "agent", handle });
  }
  const caps = JSON.stringify(opts.caps ?? ["acp", "forge.api"]);
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'claude-code', ${"claude-code:" + id}, 'leaf', ${id}, ${caps}::jsonb, ${principalId}, now(), now())`;
  return { id, handle, stationKey: "claude-code:" + id };
}

// ─── Stubs ────────────────────────────────────────────────────────────────────

type Reply = { ok: boolean; data?: unknown; error?: string };
type Call = { nodeId: string; verb: string; params: unknown };

function harness(opts: { secret?: string } = {}) {
  const secret = opts.secret ?? newSecret();
  const calls: Call[] = [];
  const minted: { account: string; name: string }[] = [];
  const revoked: { account: string; handle: { id?: number; name: string } }[] = [];
  let mintId = 500;
  const replies: Record<string, (params: unknown) => Reply | Promise<Reply>> = {
    "forge.api.status": () => ({ ok: true, data: { grants: [], publicKey: PUBLIC_KEY } }),
    "forge.api.deliver": () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } }),
  };
  const real = getProvider("forgejo", { cfg: { baseUrl: FORGE, adminToken: "admin" } });
  const provider: ForgeProvider = {
    ...real,
    async mint(account, spec) {
      minted.push({ account, name: spec.name });
      return { id: mintId++, name: spec.name, secret };
    },
    async revoke(account, handle) {
      revoked.push({ account, handle });
    },
  };
  let clock = new Date("2026-10-17T10:00:00Z");
  const errors: unknown[] = [];
  const deps: ForgeApiDeps = {
    db,
    broker: {
      async request(nodeId, verb, params) {
        calls.push({ nodeId, verb, params });
        const r = replies[verb];
        return r ? r(params) : { ok: false, error: `unknown verb: ${verb}` };
      },
    },
    providers: () => provider,
    now: () => clock,
    seal: (pk, material) => sealHandover(pk, material),
    forgeOrigin: FORGE,
  };
  return {
    secret,
    deps,
    calls,
    minted,
    revoked,
    replies,
    errors,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    deliverCalls: () => calls.filter((c) => c.verb === "forge.api.deliver"),
    /** Run and keep any thrown error for the leak check. */
    async attempt<T>(p: Promise<T>): Promise<T | undefined> {
      try {
        return await p;
      } catch (e) {
        errors.push(e);
        return undefined;
      }
    },
  };
}

function input(stationId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId: tenant,
    stationId,
    actor: OWNER,
    provider: "forgejo" as const,
    instance: FORGE,
    mode: "minted" as const,
    repositories: ["org/repo"],
    preset: "read" as const,
    rules: [],
    allowGraphql: false,
    ...over,
  };
}

const rowsFor = (stationId: string) =>
  db.select().from(g).where(eq(g.stationIdSnapshot, stationId)) as Promise<StationForgeApiGrant[]>;

// ─── Leak watch: console (the logger's sink), audit rows, grant rows, frames, errors ─────────

let logged: string[] = [];
const spies: ReturnType<typeof spyOn>[] = [];

beforeEach(() => {
  logged = [];
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(
      spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
  }
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

async function assertNoLeak(h: ReturnType<typeof harness>, stationId: string) {
  const s = h.secret;
  expect(logged.join("\n")).not.toContain(s);
  const audit = await rawSql`SELECT * FROM station_audit WHERE user_id = ${OWNER}`;
  expect(JSON.stringify(audit)).not.toContain(s);
  const rows = await rowsFor(stationId);
  expect(JSON.stringify(rows)).not.toContain(s);
  for (const r of rows) if (r.sealedBlob) expect(r.sealedBlob.startsWith("stk-handover-v1:")).toBe(true);
  expect(JSON.stringify(h.calls)).not.toContain(s);
  for (const e of h.errors) {
    expect(String(e)).not.toContain(s);
    expect(JSON.stringify(e, Object.getOwnPropertyNames(e as object))).not.toContain(s);
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "SFA" });
  tenant = BOOTSTRAP_TENANT_ID;
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, ${`sfa-box-${RUN}`}, 'sb', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

afterAll(async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_sfa_${RUN}_%`}`;
  await rawSql`DELETE FROM station_audit WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await forgetPrincipals({ handles });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createForgeApiGrant (minted)", () => {
  test("happy path ends delivered with no blob and no token anywhere", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id));
    expect(grant.state).toBe("delivered");
    expect(grant.sealedBlob).toBeNull();
    expect(grant.sealedExpiresAt).toBeNull();
    expect(grant.isolation).toBe("same-user");
    expect(grant.deliveredAt).not.toBeNull();
    expect(grant.tokenHandle).toEqual({ id: 500, name: `agentpod-${grant.id}-g1` });
    expect(h.minted).toHaveLength(1);

    const [frame] = h.deliverCalls();
    expect(frame!.nodeId).toBe(NODE);
    const p = frame!.params as Record<string, unknown>;
    expect(p).toMatchObject({
      stationId: st.id,
      stationKey: st.stationKey,
      grantId: grant.id,
      provider: "forgejo",
      instance: FORGE,
      mode: "minted",
      repositories: ["org/repo"],
      preset: "read",
      expectLogin: st.handle,
    });
    expect(String(p.sealed).startsWith("stk-handover-v1:")).toBe(true);
    expect(String(p.serviceName)).toMatch(/^forge-forgejo-[a-z0-9]+$/);

    const audit = await rawSql`SELECT verb, params_summary FROM station_audit WHERE user_id = ${OWNER} AND verb = 'forge.api.grant'`;
    expect(audit.length).toBeGreaterThan(0);
    await assertNoLeak(h, st.id);
  });

  test("account comes from the occupant even if the input names another", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(
      h.deps,
      input(st.id, { account: "intruder", expectedLogin: "intruder" }) as never,
    );
    expect(grant.account).toBe(st.handle!);
    expect(grant.expectedLogin).toBe(st.handle!);
    expect(h.minted[0]!.account).toBe(st.handle!);
    expect((h.deliverCalls()[0]!.params as { expectLogin: string }).expectLogin).toBe(st.handle!);
  });

  test("no occupant → refused before any mint", async () => {
    const h = harness();
    const st = await freshStation({ occupied: false });
    const err = await createForgeApiGrant(h.deps, input(st.id)).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("no-occupant");
    expect(err.status).toBe(409);
    expect(h.minted).toHaveLength(0);
    expect(await rowsFor(st.id)).toHaveLength(0);
  });

  test("a node without the forge.api capability → refused before any mint", async () => {
    const h = harness();
    const st = await freshStation({ caps: ["acp"] });
    const err = await createForgeApiGrant(h.deps, input(st.id)).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("capability-missing");
    expect(h.minted).toHaveLength(0);
  });

  test("station public key unavailable → typed error before any mint (no orphan token)", async () => {
    for (const reply of [
      { ok: true, data: { grants: [] } },
      { ok: false, error: "node offline" },
      { ok: false, error: "unknown verb: forge.api.status" },
    ] as Reply[]) {
      const h = harness();
      h.replies["forge.api.status"] = () => reply;
      const st = await freshStation();
      const err = await createForgeApiGrant(h.deps, input(st.id)).catch((e) => e);
      expect(err).toBeInstanceOf(ForgeApiGrantError);
      expect(err.code).toBe("station-key-unavailable");
      expect(err.status).toBe(502);
      expect(h.minted).toHaveLength(0);
      expect(await rowsFor(st.id)).toHaveLength(0);
    }
  });

  test("mint ok then seal fails → provisioned with handle persisted, reason has no secret", async () => {
    const h = harness();
    h.deps.seal = async () => {
      throw new Error(`sealer exploded holding ${h.secret}`);
    };
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(ForgeApiGrantError);
    const [row] = await rowsFor(st.id);
    expect(row!.state).toBe("provisioned");
    expect(row!.tokenHandle).toEqual({ id: 500, name: `agentpod-${row!.id}-g1` });
    expect(row!.stateReason).toMatch(/seal/);
    expect(row!.sealedBlob).toBeNull();
    expect(h.deliverCalls()).toHaveLength(0);
    await assertNoLeak(h, st.id);
  });

  test("deliver fails (node offline) → provisioned, blob kept, retry delivers without minting again", async () => {
    const h = harness();
    let seenAtDelivery: StationForgeApiGrant | undefined;
    h.replies["forge.api.deliver"] = async (params) => {
      [seenAtDelivery] = await db.select().from(g).where(eq(g.id, (params as { grantId: string }).grantId));
      return { ok: false, error: "node offline" };
    };
    const st = await freshStation();
    const first = await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    // The handle was in the database BEFORE the deliver frame went out.
    expect(seenAtDelivery!.state).toBe("provisioned");
    expect(seenAtDelivery!.tokenHandle?.name).toMatch(/^agentpod-/);
    const [row] = await rowsFor(st.id);
    expect(first?.state ?? row!.state).toBe("provisioned");
    expect(row!.state).toBe("provisioned");
    expect(row!.sealedBlob!.startsWith("stk-handover-v1:")).toBe(true);
    expect(row!.sealedExpiresAt!.getTime()).toBe(h.deps.now().getTime() + DAY);
    expect(row!.stateReason).toMatch(/offline/);

    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: true, isolation: "separate-user" } });
    const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id });
    expect(done.state).toBe("delivered");
    expect(done.isolation).toBe("separate-user");
    expect(done.sealedBlob).toBeNull();
    expect(h.minted).toHaveLength(1);
    // The retry re-sent the very blob stored, not a re-seal.
    const sent = h.deliverCalls().map((c) => (c.params as { sealed: string }).sealed);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    await assertNoLeak(h, st.id);
  });

  test("a broker that throws leaves the grant provisioned and the error carries no secret", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => {
      throw new Error("socket closed");
    };
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    const [row] = await rowsFor(st.id);
    expect(row!.state).toBe("provisioned");
    expect(row!.sealedBlob).not.toBeNull();
    await assertNoLeak(h, st.id);
  });

  test("node answers unknown verb → failed with reason, not delivered", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "unknown verb: forge.api.deliver" });
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    const [row] = await rowsFor(st.id);
    expect(row!.state).toBe("failed");
    expect(row!.stateReason).toMatch(/unknown verb/);
    expect(row!.deliveredAt).toBeNull();
    expect(row!.tokenHandle).not.toBeNull();
    await assertNoLeak(h, st.id);
  });

  test("non-positive ack never yields delivered", async () => {
    const acks: Reply[] = [
      { ok: true },
      { ok: true, data: {} },
      { ok: true, data: null },
      { ok: true, data: { ok: false, stored: true, isolation: "same-user" } },
      { ok: true, data: { ok: true, stored: false, isolation: "same-user" } },
      { ok: true, data: { ok: true, stored: true } },
      { ok: true, data: { ok: "true", stored: "true", isolation: "same-user" } },
    ];
    for (const ack of acks) {
      const h = harness();
      h.replies["forge.api.deliver"] = () => ack;
      const st = await freshStation();
      await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
      const [row] = await rowsFor(st.id);
      expect(row!.state).not.toBe("delivered");
      expect(["provisioned", "failed"]).toContain(row!.state);
      expect(row!.stateReason).toBeTruthy();
      expect(row!.deliveredAt).toBeNull();
      await assertNoLeak(h, st.id);
    }
  });

  test("frames are schema-validated before sending (a bad frame never reaches the broker)", async () => {
    const h = harness();
    h.deps.seal = async () => "plaintext-not-an-envelope";
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    expect(h.deliverCalls()).toHaveLength(0);
    const [row] = await rowsFor(st.id);
    expect(row!.state).toBe("failed");
    expect(row!.stateReason).toMatch(/frame/);
  });

  test("a second grant request for the same generation reuses the token handle instead of minting", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } });
    const again = await createForgeApiGrant(h.deps, input(st.id));
    expect(again.state).toBe("delivered");
    expect(again.generation).toBe(1);
    expect(h.minted).toHaveLength(1);
    expect(await rowsFor(st.id)).toHaveLength(1);
    await assertNoLeak(h, st.id);
  });

  test("a second request with a different repository list is refused, not merged", async () => {
    const h = harness();
    const st = await freshStation();
    await createForgeApiGrant(h.deps, input(st.id));
    const err = await createForgeApiGrant(h.deps, input(st.id, { repositories: ["org/other"] })).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("grant-exists");
    expect(h.minted).toHaveLength(1);
  });

  test("a malformed repository is a typed 422 before any mint", async () => {
    const h = harness();
    const st = await freshStation();
    const err = await createForgeApiGrant(h.deps, input(st.id, { repositories: ["no-slash"] })).catch((e) => e);
    expect(err.status).toBe(422);
    expect(h.minted).toHaveLength(0);
    expect(await rowsFor(st.id)).toHaveLength(0);
  });

  describe("a minted grant's instance must be the configured forge", () => {
    for (const ok of [FORGE, FORGE + "/", FORGE.toUpperCase().replace("HTTPS", "https")]) {
      test(`accepts ${ok}`, async () => {
        const h = harness();
        const st = await freshStation();
        const row = await createForgeApiGrant(h.deps, input(st.id, { instance: ok }));
        expect(row.state).toBe("delivered");
      });
    }
    for (const bad of [
      "https://other.sfa.test",
      "https://forge.sfa.test:8443",
      "http://forge.sfa.test",
      "https://user:pw@forge.sfa.test",
      "https://user@forge.sfa.test",
      "https://forge.sfa.test.",
      "https://forge.sfa.test./",
      "not a url",
    ]) {
      test(`rejects ${bad} before any key fetch, insert or mint`, async () => {
        const h = harness();
        const st = await freshStation();
        const err = await createForgeApiGrant(h.deps, input(st.id, { instance: bad })).catch((e) => e);
        expect(err.name).toBe("ForgeApiConfigError");
        expect(err.code).toBe("instance-not-forge");
        expect(err.status).toBe(422);
        expect(String(err.message)).not.toContain("forge.sfa.test");
        expect(h.minted).toHaveLength(0);
        expect(h.calls).toHaveLength(0);
        expect(await rowsFor(st.id)).toHaveLength(0);
      });
    }
    test("a hub with no forge origin refuses every minted grant", async () => {
      const h = harness();
      const st = await freshStation();
      const { forgeOrigin: _f, ...noForge } = h.deps;
      const err = await createForgeApiGrant(noForge, input(st.id)).catch((e) => e);
      expect(err.code).toBe("instance-not-forge");
      expect(h.minted).toHaveLength(0);
      expect(await rowsFor(st.id)).toHaveLength(0);
    });
    test("a configured forge URL with a trailing-dot host matches nothing", async () => {
      const h = harness();
      const st = await freshStation();
      const err = await createForgeApiGrant({ ...h.deps, forgeOrigin: "https://forge.sfa.test." }, input(st.id)).catch((e) => e);
      expect(err.code).toBe("instance-not-forge");
    });
    test("supplied grants are not tied to the configured forge", async () => {
      const h = harness();
      const st = await freshStation();
      const row = await createForgeApiGrant(
        h.deps,
        input(st.id, { mode: "supplied", instance: "https://elsewhere.sfa.test", expectedLogin: "sfa-bot" }),
      );
      expect(row.instance).toBe("https://elsewhere.sfa.test");
    });
  });

  test("preset none with minted mode propagates ForgeApiConfigError (422) before any mint", async () => {
    const h = harness();
    const st = await freshStation();
    const err = await createForgeApiGrant(h.deps, input(st.id, { preset: "none" })).catch((e) => e);
    expect(err.name).toBe("ForgeApiConfigError");
    expect(err.status).toBe(422);
    expect(h.minted).toHaveLength(0);
  });
});

describe("deliverGrant retry", () => {
  for (const kind of ["expired", "missing"] as const) {
    test(`${kind} blob → revoke the old token, re-mint generation+1, deliver`, async () => {
      const h = harness();
      h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
      const st = await freshStation();
      await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
      const [row] = await rowsFor(st.id);
      const oldHandle = row!.tokenHandle!;
      if (kind === "expired") h.advance(DAY + 1000);
      else await rawSql`UPDATE station_forge_api_grants SET sealed_blob = NULL, sealed_expires_at = NULL WHERE id = ${row!.id}`;

      h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } });
      const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id });
      expect(h.revoked).toEqual([{ account: st.handle!, handle: oldHandle }]);
      expect(h.minted).toHaveLength(2);
      expect(done.generation).toBe(2);
      expect(done.tokenHandle!.name).toBe(`agentpod-${row!.id}-g2`);
      expect(done.state).toBe("delivered");
      expect(done.sealedBlob).toBeNull();
      await assertNoLeak(h, st.id);
    });
  }

  test("a delivered grant is not re-delivered", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id));
    const again = await deliverGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(again.state).toBe("delivered");
    expect(h.deliverCalls()).toHaveLength(1);
  });
});

describe("transition", () => {
  async function row(state: string) {
    const st = await freshStation();
    const id = `fag_t_${RUN}_${seq++}`;
    await db.insert(g).values({
      id,
      tenantId: tenant,
      stationId: st.id,
      stationIdSnapshot: st.id,
      provider: "forgejo",
      instance: FORGE,
      mode: "minted",
      account: "a",
      repositories: ["o/r"],
      preset: "read",
      state: state as never,
      generation: 1,
      createdBy: OWNER,
      revokedAt: state === "revoked" ? new Date() : null,
    });
    return { tenantId: tenant, id };
  }
  const now = new Date();

  test("allowed edges move the row; the graph refuses the rest", async () => {
    const allowed: [string, string][] = [
      ["authorised", "provisioned"],
      ["provisioned", "delivered"],
      ["delivered", "verified"],
      ["provisioned", "provisioned"],
      ["failed", "provisioned"],
      // A retry whose node positively acknowledges the credential it kept.
      ["failed", "delivered"],
      ["authorised", "failed"],
      ["verified", "failed"],
      ["delivered", "revoking"],
      ["revoking", "revoked"],
    ];
    for (const [from, to] of allowed) {
      const ref = await row(from);
      const out = await transition(db, ref, [from as never], to as never, { now });
      expect(out.state as string).toBe(to);
    }
    const refused: [string, string][] = [
      ["authorised", "delivered"],
      ["provisioned", "verified"],
      ["revoked", "provisioned"],
      ["revoked", "failed"],
      ["delivered", "provisioned"],
      ["authorised", "revoked"],
    ];
    for (const [from, to] of refused) {
      const ref = await row(from);
      const err = await transition(db, ref, [from as never], to as never, { now }).catch((e) => e);
      expect(err).toBeInstanceOf(ForgeApiGrantError);
      expect(err.code).toBe("bad-transition");
      const [still] = await db.select().from(g).where(eq(g.id, ref.id));
      expect(still!.state).toBe(from as never);
    }
  });

  test("a row not in an expected state is a conflict, not a silent overwrite", async () => {
    const ref = await row("delivered");
    const err = await transition(db, ref, ["authorised"], "provisioned", { now }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("state-conflict");
  });

  test("revoked sets revoked_at in the same update; sealed fields move together", async () => {
    const ref = await row("revoking");
    const out = await transition(db, ref, ["revoking"], "revoked", { now });
    expect(out.revokedAt).not.toBeNull();

    const p = await row("authorised");
    const sealed = await transition(db, p, ["authorised"], "provisioned", {
      now,
      sealed: { blob: "stk-handover-v1:x", expiresAt: new Date(now.getTime() + DAY) },
    });
    expect(sealed.sealedBlob).toBe("stk-handover-v1:x");
    expect(sealed.sealedExpiresAt).not.toBeNull();
    const cleared = await transition(db, p, ["provisioned"], "delivered", { now, sealed: null });
    expect(cleared.sealedBlob).toBeNull();
    expect(cleared.sealedExpiresAt).toBeNull();
    expect(cleared.updatedAt.getTime()).toBe(now.getTime());
  });
});

// ─── Fix round 1: no orphan token, no double mint ─────────────────────────────

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Make the harness's mint slow: it signals when entered and waits for `release`. */
function slowMint(h: ReturnType<typeof harness>) {
  const entered = deferred();
  const release = deferred();
  const provider = h.deps.providers("forgejo");
  const fast = provider.mint!.bind(provider);
  provider.mint = async (account, spec) => {
    entered.resolve();
    await release.promise;
    return fast(account, spec);
  };
  return { entered: entered.promise, release: () => release.resolve() };
}

async function failedGrantWithoutHandle(h: ReturnType<typeof harness>) {
  const provider = h.deps.providers("forgejo");
  const real = provider.mint!;
  provider.mint = async () => {
    throw new Error("forge: minting was refused (HTTP 422).");
  };
  const st = await freshStation();
  await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
  provider.mint = real;
  h.errors.length = 0;
  h.revoked.length = 0;
  const [row] = await rowsFor(st.id);
  expect(row!.state).toBe("failed");
  expect(row!.tokenHandle).toBeNull();
  return { st, row: row! };
}

describe("no orphan token", () => {
  test("persisting the handle fails after a successful mint → exactly one compensating revoke, typed error, no secret", async () => {
    const h = harness();
    const target = { stationId: "" };
    const provider = h.deps.providers("forgejo");
    const fast = provider.mint!.bind(provider);
    provider.mint = async (account, spec) => {
      // Something else moves the row underneath, so the persist UPDATE finds no `authorised` row.
      await rawSql`UPDATE station_forge_api_grants SET state = 'revoking' WHERE station_id_snapshot = ${target.stationId}`;
      return fast(account, spec);
    };
    const st = await freshStation();
    target.stationId = st.id;
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(ForgeApiGrantError);
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("handle-persist-failed");
    expect((h.errors[0] as ForgeApiGrantError).status).toBe(500);
    const [row] = await rowsFor(st.id);
    expect(h.revoked).toEqual([{ account: st.handle!, handle: { id: 500, name: `agentpod-${row!.id}-g1` } }]);
    await assertNoLeak(h, st.id);
  });

  test("an ambiguous mint failure → best-effort revoke by the deterministic name, grant failed", async () => {
    const h = harness();
    const provider = h.deps.providers("forgejo");
    provider.mint = async () => {
      throw new Error("forge: minting a token was refused (HTTP 502).");
    };
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    const [row] = await rowsFor(st.id);
    expect(row!.state).toBe("failed");
    expect(h.revoked).toEqual([{ account: st.handle!, handle: { name: `agentpod-${row!.id}-g1` } }]);
  });

  test("a revoke that answers 404 on re-mint is success, not revoke-failed", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    const [row] = await rowsFor(st.id);
    h.deps.providers("forgejo").revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 404).");
    };
    h.advance(DAY + 1000);
    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } });
    const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id });
    expect(done.state).toBe("delivered");
    expect(done.generation).toBe(2);
  });
});

describe("no double mint", () => {
  test("two concurrent deliverGrant calls → exactly one mint; the loser is grant-busy", async () => {
    const h = harness();
    const { row } = await failedGrantWithoutHandle(h);
    const slow = slowMint(h);
    const first = deliverGrant(h.deps, { tenantId: tenant, grantId: row.id });
    await slow.entered;
    const second = await deliverGrant(h.deps, { tenantId: tenant, grantId: row.id }).catch((e) => e);
    expect(second).toBeInstanceOf(ForgeApiGrantError);
    expect(second.code).toBe("grant-busy");
    expect(second.status).toBe(409);
    slow.release();
    const won = await first;
    expect(won.state).toBe("delivered");
    expect(h.minted).toHaveLength(1);
  });

  test("two concurrent re-mints of an expired-blob grant → exactly one revoke and one mint", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const st = await freshStation();
    await h.attempt(createForgeApiGrant(h.deps, input(st.id)));
    const [row] = await rowsFor(st.id);
    h.advance(DAY + 1000);
    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: true, isolation: "same-user" } });
    const slow = slowMint(h);
    const first = deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id });
    await slow.entered;
    const second = await deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id }).catch((e) => e);
    expect(second.code).toBe("grant-busy");
    slow.release();
    expect((await first).generation).toBe(2);
    expect(h.revoked).toHaveLength(1);
    expect(h.minted).toHaveLength(2);
  });

  test("concurrent createForgeApiGrant on the same station/provider/instance → one mint", async () => {
    const h = harness();
    const st = await freshStation();
    const slow = slowMint(h);
    const first = createForgeApiGrant(h.deps, input(st.id));
    await slow.entered;
    const second = await createForgeApiGrant(h.deps, input(st.id)).catch((e) => e);
    expect(second.code).toBe("grant-busy");
    slow.release();
    expect((await first).state).toBe("delivered");
    expect(h.minted).toHaveLength(1);
    expect(await rowsFor(st.id)).toHaveLength(1);
  });

  test("the claim is released when mint throws: a follow-up call proceeds", async () => {
    const h = harness();
    const { row } = await failedGrantWithoutHandle(h);
    const provider = h.deps.providers("forgejo");
    const real = provider.mint!;
    provider.mint = async () => {
      throw new Error("forge: minting was refused (HTTP 500).");
    };
    await h.attempt(deliverGrant(h.deps, { tenantId: tenant, grantId: row.id }));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("mint-failed");
    provider.mint = real;
    const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: row.id });
    expect(done.state).toBe("delivered");
  });
});

describe("claims never exhaust the pool", () => {
  test("the claim cap leaves at least POOL_RESERVE connections for the rest of the hub", () => {
    const poolMax = (rawSql as unknown as { options: { max: number } }).options.max;
    expect(POOL_RESERVE).toBeGreaterThanOrEqual(3);
    expect(CLAIM_CAP).toBeGreaterThanOrEqual(1);
    expect(CLAIM_CAP).toBeLessThanOrEqual(poolMax - POOL_RESERVE);
  });

  test("15 concurrent claims on different grants: at most CLAIM_CAP mint, the rest are grant-busy at once, the pool stays usable", async () => {
    const h = harness();
    const grants: string[] = [];
    for (let i = 0; i < 15; i++) grants.push((await failedGrantWithoutHandle(h)).row.id);
    const provider = h.deps.providers("forgejo");
    const fast = provider.mint!.bind(provider);
    const release = deferred();
    let inMint = 0;
    let maxInMint = 0;
    provider.mint = async (account, spec) => {
      inMint++;
      maxInMint = Math.max(maxInMint, inMint);
      await release.promise;
      inMint--;
      return fast(account, spec);
    };
    const outcomes: (Grant | Error)[] = [];
    const runs = grants.map((id) =>
      deliverGrant(h.deps, { tenantId: tenant, grantId: id }).then(
        (r) => void outcomes.push(r as never),
        (e) => void outcomes.push(e),
      ),
    );
    await pollUntil(() => inMint === CLAIM_CAP && outcomes.length === 15 - CLAIM_CAP);
    expect(maxInMint).toBe(CLAIM_CAP);
    for (const o of outcomes) {
      expect(o).toBeInstanceOf(ForgeApiGrantError);
      expect((o as ForgeApiGrantError).code).toBe("grant-busy");
    }
    // An unrelated query through the same pool completes while the claims are held.
    const [one] = await db.execute(sql`SELECT 1 AS one`);
    expect(Number((one as { one: number }).one)).toBe(1);
    release.resolve();
    await Promise.all(runs);
    expect(maxInMint).toBe(CLAIM_CAP);
    // A slot is free again: a grant that was busy can now be claimed.
    const rows = await Promise.all(grants.map(async (id) => (await db.select().from(g).where(eq(g.id, id)))[0]!));
    const row = rows.find((r) => r.state === "failed");
    expect(rows.filter((r) => r.state === "delivered")).toHaveLength(CLAIM_CAP);
    const next = await deliverGrant(h.deps, { tenantId: tenant, grantId: row!.id });
    expect(next.state).toBe("delivered");
  });

  test("an unlock that fails never returns a connection still holding the session lock", async () => {
    const h = harness();
    const { row } = await failedGrantWithoutHandle(h);
    claimFaults.failUnlock = true;
    try {
      await deliverGrant(h.deps, { tenantId: tenant, grantId: row.id });
    } finally {
      claimFaults.failUnlock = false;
    }
    // A different session must be able to take the same lock: nothing leaked it.
    const other = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const key = `forge-grant|${tenant}|${row.id}`;
      const [r] = await other`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS ok`;
      expect(r!.ok).toBe(true);
      await other`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      await other.end();
    }
  });
});
