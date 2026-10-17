/**
 * The forge API grant lifecycle after delivery: verify, rotate, revoke, policy, and the supplied
 * and app modes (spec docs/superpowers/specs/2026-10-17-forge-api-access-design.md, "Lifecycle and
 * failure handling").
 *
 * The guards these tests exist for: the old token is revoked only after the new one verifies; the
 * previous handle is persisted before the new token is delivered; revocation goes to the provider
 * first and is never lost; the hub never opens a supplied blob; no token reaches any sink.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import handoverFixture from "../../../../packages/contract/fixtures/handover-v1.json";

import { db, rawSql } from "../../src/db/drizzle";
import { resolveTenantForUser } from "../../src/auth/tenant";
import { stationForgeApiGrants as g, type StationForgeApiGrant as Grant } from "../../src/db/schema/forge-api-grants";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { getProvider, type ForgeProvider } from "../../src/services/forge-api/providers";
import { githubProvider } from "../../src/services/forge-api/github";
import { sealHandover } from "../../src/services/handover-seal";
import {
  acceptSuppliedSecret,
  confirmSuppliedRevoked,
  createForgeApiGrant,
  deliverGrant,
  registerAppGrant,
  revokeGrant,
  rotateGrant,
  updateGrantPolicy,
  verifyGrant,
  ForgeApiGrantError,
  type ForgeApiDeps,
} from "../../src/services/station-forge-api";

const RUN = crypto.randomUUID().slice(0, 8);
const OWNER = `test-user-sfl-${RUN}`;
const NODE = `node_sfl_${RUN}`;
const FORGE = "https://forge.sfl.test";
const PUBLIC_KEY = (handoverFixture as { public_key: string }).public_key;
const DAY = 24 * 60 * 60 * 1000;
const ACK = { ok: true, data: { ok: true, stored: true, isolation: "same-user" } };

let tenant: string;
let seq = 0;
const handles: string[] = [];

const newSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

async function freshStation(opts: { occupied?: boolean } = {}) {
  const id = `station_sfl_${RUN}_${seq++}`;
  let principalId: string | null = null;
  let handle: string | null = null;
  if (opts.occupied !== false) {
    handle = `sfl-agent-${RUN}-${seq}`;
    handles.push(handle);
    principalId = await createPrincipal({ kind: "agent", handle });
  }
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, adopted_at, created_at)
    VALUES (${id}, ${tenant}, ${OWNER}, ${NODE}, 'claude-code', ${"claude-code:" + id}, 'leaf', ${id}, ${JSON.stringify(["acp", "forge.api"])}::jsonb, ${principalId}, now(), now())`;
  return { id, handle: handle!, stationKey: "claude-code:" + id };
}

type Reply = { ok: boolean; data?: unknown; error?: string };
type Call = { nodeId: string; verb: string; params: unknown };

function harness() {
  const secrets: string[] = [];
  const calls: Call[] = [];
  /** Every provider and node event in order, to prove sequencing. */
  const events: string[] = [];
  const minted: { account: string; name: string }[] = [];
  const revoked: { account: string; handle: { id?: number; name: string } }[] = [];
  let mintId = 500;
  let login = "";
  let checkLogin: string | undefined;
  const checked: string[] = [];
  const replies: Record<string, (params: unknown) => Reply | Promise<Reply>> = {
    "forge.api.status": () => ({ ok: true, data: { grants: [], publicKey: PUBLIC_KEY } }),
    "forge.api.deliver": () => ACK,
    "forge.api.verify": () => ({ ok: true, data: { ok: true, login, isolation: "separate-user" } }),
    "forge.api.revoke": () => ({ ok: true, data: { removed: true } }),
    "forge.api.policy": () => ({ ok: true, data: { ok: true } }),
  };
  const real = getProvider("forgejo", { cfg: { baseUrl: FORGE, adminToken: "admin" } });
  const provider: ForgeProvider = {
    ...real,
    async mint(account, spec) {
      const secret = newSecret();
      secrets.push(secret);
      minted.push({ account, name: spec.name });
      events.push(`mint:${spec.name}`);
      return { id: mintId++, name: spec.name, secret };
    },
    async revoke(account, handle) {
      events.push(`revoke:${handle.name}`);
      revoked.push({ account, handle });
    },
    async checkToken(account, secret) {
      events.push("check");
      checked.push(secret);
      return { login: checkLogin ?? account };
    },
  };
  const deps: ForgeApiDeps = {
    db,
    broker: {
      async request(nodeId, verb, params) {
        calls.push({ nodeId, verb, params });
        events.push(verb);
        const r = replies[verb];
        return r ? r(params) : { ok: false, error: `unknown verb: ${verb}` };
      },
    },
    providers: (kind) => (kind === "github" ? githubProvider : provider),
    forgeOrigin: FORGE,
    now: () => new Date("2026-10-17T10:00:00Z"),
    seal: (pk, material) => sealHandover(pk, material),
  };
  const errors: unknown[] = [];
  return {
    secrets,
    deps,
    calls,
    events,
    minted,
    revoked,
    replies,
    provider,
    errors,
    setLogin(l: string) {
      login = l;
    },
    setCheckLogin(l: string) {
      checkLogin = l;
    },
    checked,
    callsOf: (verb: string) => calls.filter((c) => c.verb === verb),
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
type H = ReturnType<typeof harness>;

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

const load = async (id: string) => (await db.select().from(g).where(eq(g.id, id)))[0]!;

/** A delivered minted grant, generation 1, on a fresh station. */
async function delivered(h: H) {
  const st = await freshStation();
  h.setLogin(st.handle);
  const grant = await createForgeApiGrant(h.deps, input(st.id));
  expect(grant.state).toBe("delivered");
  h.events.length = 0;
  h.calls.length = 0;
  return { st, grant, ref: { tenantId: tenant, grantId: grant.id } };
}

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

async function assertNoLeak(h: H, grantId: string) {
  expect(h.secrets.length).toBeGreaterThan(0);
  const audit = JSON.stringify(await rawSql`SELECT * FROM station_audit WHERE user_id = ${OWNER}`);
  const row = JSON.stringify(await load(grantId));
  for (const s of h.secrets) {
    expect(logged.join("\n")).not.toContain(s);
    expect(audit).not.toContain(s);
    expect(row).not.toContain(s);
    expect(JSON.stringify(h.calls)).not.toContain(s);
    for (const e of h.errors) {
      expect(String(e)).not.toContain(s);
      expect(JSON.stringify(e, Object.getOwnPropertyNames(e as object))).not.toContain(s);
    }
  }
}

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "SFL" });
  tenant = await resolveTenantForUser(OWNER);
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${NODE}, ${tenant}, ${OWNER}, ${`sfl-box-${RUN}`}, 'sb', 'linux', 'amd64', 2, 'online', 'x', now())`;
});

afterAll(async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_sfl_${RUN}_%`}`;
  await rawSql`DELETE FROM station_audit WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM stations WHERE node_id = ${NODE}`;
  await rawSql`DELETE FROM nodes WHERE id = ${NODE}`;
  await forgetPrincipals({ handles });
});

// ─── verify ───────────────────────────────────────────────────────────────────

describe("verifyGrant", () => {
  test("verify moves delivered→verified and records the login", async () => {
    const h = harness();
    const { st, grant, ref } = await delivered(h);
    const out = await verifyGrant(h.deps, ref);
    expect(out.outcome).toBe("verified");
    expect(out.grant.state).toBe("verified");
    expect(out.grant.verifiedAt).not.toBeNull();
    expect(out.grant.isolation).toBe("separate-user");
    expect(out.grant.stateReason).toBeNull();
    const [frame] = h.callsOf("forge.api.verify");
    expect(frame!.params).toEqual({ stationId: st.id, grantId: grant.id, expectLogin: st.handle });
  });

  test("the login matches case-insensitively", async () => {
    const h = harness();
    const { st, ref } = await delivered(h);
    h.setLogin(st.handle.toUpperCase());
    expect((await verifyGrant(h.deps, ref)).grant.state).toBe("verified");
  });

  test("wrong login → failed wrong-identity", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.setLogin("someone-else");
    const out = await verifyGrant(h.deps, ref);
    expect(out.outcome).toBe("failed");
    expect(out.grant.state).toBe("failed");
    expect(out.grant.stateReason).toMatch(/^wrong-identity/);
    expect(out.grant.verifiedAt).toBeNull();
  });

  test("the node's reason is length-capped and stripped of control characters", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.replies["forge.api.verify"] = () => ({
      ok: true,
      data: { ok: false, reason: `unauthorized: bad\u0000token\n\u001b[31m${"x".repeat(1000)}`, isolation: "same-user" },
    });
    const out = await verifyGrant(h.deps, ref);
    expect(out.grant.state).toBe("failed");
    const reason = out.grant.stateReason!;
    expect(reason).toContain("badtoken");
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(reason.length).toBeLessThanOrEqual(240);
  });

  test("node offline leaves the grant delivered and says so", async () => {
    for (const reply of [{ ok: false, error: "node offline" }, { ok: false, error: "timeout" }] as Reply[]) {
      const h = harness();
      const { ref } = await delivered(h);
      h.replies["forge.api.verify"] = () => reply;
      const out = await verifyGrant(h.deps, ref);
      expect(out.outcome).toBe("node-offline");
      expect(out.grant.state).toBe("delivered");
      expect((await load(ref.grantId)).state).toBe("delivered");
    }
  });

  test("an old node (unknown verb) → failed node-too-old; an empty reply is never verified", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    delete h.replies["forge.api.verify"];
    const out = await verifyGrant(h.deps, ref);
    expect(out.grant.state).toBe("failed");
    expect(out.grant.stateReason).toMatch(/^node-too-old/);

    const h2 = harness();
    const d2 = await delivered(h2);
    h2.replies["forge.api.verify"] = () => ({ ok: true, data: {} });
    expect((await verifyGrant(h2.deps, d2.ref)).grant.state).toBe("failed");
  });

  test("a grant that was never delivered cannot be verified", async () => {
    const h = harness();
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id));
    const err = await verifyGrant(h.deps, { tenantId: tenant, grantId: grant.id }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("grant-not-verifiable");
    expect(h.callsOf("forge.api.verify")).toHaveLength(0);
  });

  test("verify is tenant-scoped", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    const err = await verifyGrant(h.deps, { tenantId: "tenant-nope", grantId: ref.grantId }).catch((e) => e);
    expect(err.code).toBe("grant-not-found");
  });
});

// ─── rotate ───────────────────────────────────────────────────────────────────

describe("rotateGrant (minted)", () => {
  test("rotation revokes the old generation only after the new verifies", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const oldHandle = grant.tokenHandle!;
    const out = await rotateGrant(h.deps, ref);
    expect(out.state).toBe("verified");
    expect(out.generation).toBe(2);
    expect(out.tokenHandle).toEqual({ id: 501, name: `agentpod-${grant.id}-g2` });
    expect(h.revoked.map((r) => r.handle)).toEqual([oldHandle]);
    // Sequence: mint the new one, deliver it, verify it, THEN revoke the old one.
    expect(h.events).toEqual([
      "forge.api.status",
      `mint:agentpod-${grant.id}-g2`,
      "check",
      "forge.api.deliver",
      "forge.api.verify",
      `revoke:${oldHandle.name}`,
    ]);
    await assertNoLeak(h, grant.id);
  });

  test("a definitive wrong-identity after the node acked: the new token AND the superseded old one are revoked, grant failed", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const oldHandle = grant.tokenHandle!;
    h.setLogin("wrong-account");
    await h.attempt(rotateGrant(h.deps, ref));
    expect(h.errors).toHaveLength(1);
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    // After an ack the node no longer holds n: it is superseded, so it goes too (best effort).
    expect(h.revoked.map((r) => r.handle)).toEqual([{ id: 501, name: `agentpod-${grant.id}-g2` }, oldHandle]);
    const row = await load(grant.id);
    expect(row.state).toBe("failed");
    expect(row.stateReason).toMatch(/^rotation-failed/);
    expect(row.tokenHandle).toEqual({ id: 501, name: `agentpod-${grant.id}-g2` });
    await assertNoLeak(h, grant.id);
  });

  test("a pre-ack failure whose compensating revoke fails records the new token as orphan", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.setCheckLogin("someone-else");
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 503).");
    };
    await h.attempt(rotateGrant(h.deps, ref));
    const row = await load(grant.id);
    expect(row.tokenHandle).toEqual({ ...grant.tokenHandle!, orphan: { id: 501, name: `agentpod-${grant.id}-g2` } });
    expect(row.generation).toBe(1);
  });

  test("rotation crash safety: the previous handle is persisted before the new token is delivered", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    let atDelivery: Grant | undefined;
    h.replies["forge.api.deliver"] = async () => {
      atDelivery = await load(grant.id);
      return ACK;
    };
    await rotateGrant(h.deps, ref);
    expect(atDelivery!.tokenHandle).toMatchObject({
      id: 501,
      name: `agentpod-${grant.id}-g2`,
      previous: { ...grant.tokenHandle!, disposition: "live-until-verified", generation: 1 },
    });
    expect(atDelivery!.generation).toBe(2);
    // The blob is on the row BEFORE the frame goes out: a crash here still says "not acked".
    expect(atDelivery!.sealedBlob!.startsWith("stk-handover-v1:")).toBe(true);
    expect(atDelivery!.deliveredAt).toBeNull();
  });

  test("the previous handle is persisted before the mint, too", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    let atMint: Grant | undefined;
    const fast = h.provider.mint!.bind(h.provider);
    h.provider.mint = async (a, s) => {
      atMint = await load(grant.id);
      return fast(a, s);
    };
    await rotateGrant(h.deps, ref);
    expect(atMint!.tokenHandle?.previous).toMatchObject({ ...grant.tokenHandle!, disposition: "live-until-verified" });
  });

  test("a delivery that is not acknowledged fails the rotation and revokes the new token", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: true, stored: false, isolation: "same-user" } });
    await h.attempt(rotateGrant(h.deps, ref));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    expect(h.callsOf("forge.api.verify")).toHaveLength(0);
    expect(h.revoked.map((r) => r.handle.name)).toEqual([`agentpod-${grant.id}-g2`]);
    expect((await load(grant.id)).tokenHandle).toEqual(grant.tokenHandle);
    await assertNoLeak(h, grant.id);
  });

  test("a seal failure fails the rotation without leaking the token", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.deps.seal = async () => {
      throw new Error(`sealer exploded holding ${h.secrets.at(-1)}`);
    };
    await h.attempt(rotateGrant(h.deps, ref));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    expect((await load(grant.id)).tokenHandle).toEqual(grant.tokenHandle);
    await assertNoLeak(h, grant.id);
  });

  test("node offline before the mint → typed error, nothing minted, nothing changed", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.status"] = () => ({ ok: false, error: "node offline" });
    const err = await rotateGrant(h.deps, ref).catch((e) => e);
    expect(err.code).toBe("station-key-unavailable");
    expect(h.minted).toHaveLength(1);
    const row = await load(grant.id);
    expect(row.state).toBe("delivered");
    expect(row.tokenHandle).toEqual(grant.tokenHandle);
  });

  test("concurrent rotate + revoke on one grant: one wins, the other is grant-busy", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    let entered!: () => void;
    const inMint = new Promise<void>((r) => (entered = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fast = h.provider.mint!.bind(h.provider);
    h.provider.mint = async (a, s) => {
      entered();
      await gate;
      return fast(a, s);
    };
    const rotating = rotateGrant(h.deps, ref);
    await inMint;
    const err = await revokeGrant(h.deps, ref).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeApiGrantError);
    expect(err.code).toBe("grant-busy");
    release();
    expect((await rotating).state).toBe("verified");
  });
});

// ─── revoke ───────────────────────────────────────────────────────────────────

describe("revokeGrant", () => {
  test("happy path: node wipe first, then the provider, then revoked in one step", async () => {
    const h = harness();
    const { st, grant, ref } = await delivered(h);
    const out = await revokeGrant(h.deps, ref);
    expect(out.outcome).toBe("revoked");
    expect(out.grant.state).toBe("revoked");
    expect(out.grant.revokedAt).not.toBeNull();
    // The node wipe goes first: it cuts the station's access at once.
    expect(h.events).toEqual(["forge.api.revoke", `revoke:${grant.tokenHandle!.name}`]);
    expect(h.callsOf("forge.api.revoke")[0]!.params).toEqual({ stationId: st.id, grantId: grant.id });
  });

  test("revoke with node offline still revokes at the provider and leaves the wipe queued", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.revoke"] = () => ({ ok: false, error: "node offline" });
    const out = await revokeGrant(h.deps, ref);
    expect(out.outcome).toBe("wipe-pending");
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!]);
    const row = await load(grant.id);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toMatch(/^wipe-pending/);
    // Reconnect: the retry only wipes; the provider is not asked again.
    h.replies["forge.api.revoke"] = () => ({ ok: true, data: { removed: true } });
    const done = await revokeGrant(h.deps, ref);
    expect(done.grant.state).toBe("revoked");
    expect(h.revoked).toHaveLength(1);
  });

  test("revoke when the provider is down stays revoking and is retried (not lost)", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const ok = h.provider.revoke!;
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 503).");
    };
    const out = await revokeGrant(h.deps, ref);
    expect(out.outcome).toBe("pending");
    const row = await load(grant.id);
    expect(row.state).toBe("revoking");
    expect(row.stateReason).toMatch(/^provider-pending/);
    expect(row.stateReason).not.toMatch(/wipe-pending/);
    // The node wipe was still sent: the station's access is cut even while the forge is down.
    expect(h.callsOf("forge.api.revoke")).toHaveLength(1);
    h.provider.revoke = ok;
    const done = await revokeGrant(h.deps, ref);
    expect(done.grant.state).toBe("revoked");
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!]);
    // Resume did only the outstanding side.
    expect(h.callsOf("forge.api.revoke")).toHaveLength(1);
  });

  test("a provider 404 is success", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 404).");
    };
    expect((await revokeGrant(h.deps, ref)).grant.state).toBe("revoked");
  });

  test("a pending previous handle is revoked too", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const prev = { id: 77, name: `agentpod-${grant.id}-g0` };
    const orphan = { id: 78, name: `agentpod-${grant.id}-g9` };
    await rawSql`UPDATE station_forge_api_grants SET token_handle = ${JSON.stringify({ ...grant.tokenHandle!, previous: { ...prev, disposition: "revoke" }, orphan })}::jsonb WHERE id = ${grant.id}`;
    await revokeGrant(h.deps, ref);
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!, prev, orphan]);
  });

  test("revoke works with the station gone (station_id NULL): provider revoked, revoked with the wipe skipped", async () => {
    const h = harness();
    const { st, grant, ref } = await delivered(h);
    await rawSql`DELETE FROM stations WHERE id = ${st.id}`;
    expect((await load(grant.id)).stationId).toBeNull();
    const out = await revokeGrant(h.deps, ref);
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!]);
    expect(h.calls).toHaveLength(0);
    expect(out.outcome).toBe("revoked");
    expect(out.grant.state).toBe("revoked");
    expect(out.grant.revokedAt).not.toBeNull();
    expect(out.grant.stateReason).toBe("revoked; node wipe skipped: station-gone (credential inert)");
  });

  test("station gone and the provider down: stays revoking provider-pending until the provider answers", async () => {
    const h = harness();
    const { st, grant, ref } = await delivered(h);
    await rawSql`DELETE FROM stations WHERE id = ${st.id}`;
    const ok = h.provider.revoke!;
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 503).");
    };
    const out = await revokeGrant(h.deps, ref);
    expect(out.grant.state).toBe("revoking");
    expect(out.grant.stateReason).toMatch(/^provider-pending/);
    h.provider.revoke = ok;
    const done = await revokeGrant(h.deps, ref);
    expect(done.grant.state).toBe("revoked");
    expect(done.grant.stateReason).toMatch(/station-gone/);
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!]);
  });

  test("provider down AND node offline: both sides pending, each resumed independently", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const ok = h.provider.revoke!;
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 503).");
    };
    h.replies["forge.api.revoke"] = () => ({ ok: false, error: "node offline" });
    const first = await revokeGrant(h.deps, ref);
    expect(first.grant.stateReason).toMatch(/provider-pending/);
    expect(first.grant.stateReason).toMatch(/wipe-pending/);
    h.provider.revoke = ok;
    const second = await revokeGrant(h.deps, ref);
    expect(second.grant.state).toBe("revoking");
    expect(second.grant.stateReason).toMatch(/^wipe-pending/);
    expect(second.grant.stateReason).not.toMatch(/provider-pending/);
    h.replies["forge.api.revoke"] = () => ({ ok: true, data: { removed: false } });
    const third = await revokeGrant(h.deps, ref);
    expect(third.grant.state).toBe("revoked");
    expect(h.revoked.map((r) => r.handle)).toEqual([grant.tokenHandle!]);
  });

  test("supplied with the station gone: the operator's confirmation completes it", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    await rawSql`DELETE FROM stations WHERE id = ${st.id}`;
    const out = await revokeGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(out.grant.stateReason).toMatch(/^revocation-pending-operator/);
    const done = await confirmSuppliedRevoked(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(done.grant.state).toBe("revoked");
    expect(done.grant.stateReason).toMatch(/station-gone/);
  });

  test("revoking never mints and never asks for the station key; a revoked grant stays revoked", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    const minted = h.minted.length;
    await revokeGrant(h.deps, ref);
    const again = await revokeGrant(h.deps, ref);
    expect(again.outcome).toBe("revoked");
    expect(h.minted).toHaveLength(minted);
    expect(h.callsOf("forge.api.status")).toHaveLength(0);
  });

  test("an old node that does not know forge.api.revoke leaves the wipe pending", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    delete h.replies["forge.api.revoke"];
    const out = await revokeGrant(h.deps, ref);
    expect(out.grant.state).toBe("revoking");
    expect(out.grant.stateReason).toMatch(/^wipe-pending/);
  });
});

// ─── supplied and app modes ───────────────────────────────────────────────────

/** Not a real envelope: if the hub tried to open it, it would fail. */
const OPAQUE = `stk-handover-v1:${"Zm9v".repeat(20)}-not-decryptable`;

describe("supplied and app modes", () => {
  test("a supplied grant is created without minting, for the operator-declared login", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    expect(grant.state).toBe("authorised");
    expect(grant.account).toBe("machine-bot");
    expect(grant.expectedLogin).toBe("machine-bot");
    expect(grant.principalId).not.toBeNull();
    expect(grant.tokenHandle).toBeNull();
    expect(h.minted).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  test("a supplied grant without a declared login is refused", async () => {
    const h = harness();
    const st = await freshStation();
    const err = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied" })).catch((e) => e);
    expect(err.code).toBe("expected-login-required");
    expect(err.status).toBe(422);
  });

  test("the hub never opens a supplied blob: it is relayed byte-identical", async () => {
    const h = harness();
    h.deps.seal = async () => {
      throw new Error("the hub must not seal or open anything here");
    };
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    const out = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    expect(out.state).toBe("delivered");
    expect(out.sealedBlob).toBeNull();
    const [frame] = h.callsOf("forge.api.deliver");
    expect((frame!.params as { sealed: string }).sealed).toBe(OPAQUE);
    expect((frame!.params as { mode: string }).mode).toBe("supplied");
    expect((frame!.params as { expectLogin: string }).expectLogin).toBe("machine-bot");
    expect(h.minted).toHaveLength(0);
  });

  test("a supplied blob that is not an envelope, or too large, is refused before any frame", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    for (const sealed of ["ghp_plaintexttoken", "stk-handover-v1:", `stk-handover-v1:${"a".repeat(16 * 1024)}`]) {
      const err = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed }).catch((e) => e);
      expect(err.code).toBe("bad-sealed-blob");
      expect(err.message).not.toContain("ghp_plaintexttoken");
    }
    expect(h.calls).toHaveLength(0);
  });

  test("a supplied blob the node cannot take right now is kept for 24 h and re-sent unchanged", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const first = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    expect(first.state).toBe("provisioned");
    expect(first.sealedBlob).toBe(OPAQUE);
    expect(first.sealedExpiresAt!.getTime()).toBe(h.deps.now().getTime() + DAY);
    h.replies["forge.api.deliver"] = () => ACK;
    const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(done.state).toBe("delivered");
    expect(h.callsOf("forge.api.deliver").map((c) => (c.params as { sealed: string }).sealed)).toEqual([OPAQUE, OPAQUE]);
  });

  test("a supplied grant whose blob expired is never re-minted", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    await rawSql`UPDATE station_forge_api_grants SET sealed_blob = NULL, sealed_expires_at = NULL WHERE id = ${grant.id}`;
    const err = await deliverGrant(h.deps, { tenantId: tenant, grantId: grant.id }).catch((e) => e);
    expect(err.code).toBe("grant-not-deliverable");
    expect(h.minted).toHaveLength(0);
  });

  test("supplied rotation is a new sealed credential on a delivered grant", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    h.setLogin("machine-bot");
    expect((await verifyGrant(h.deps, { tenantId: tenant, grantId: grant.id })).grant.state).toBe("verified");
    const next = `${OPAQUE}-2`;
    const out = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: next });
    expect(out.state).toBe("delivered");
    expect((h.callsOf("forge.api.deliver").at(-1)!.params as { sealed: string }).sealed).toBe(next);
    const err = await rotateGrant(h.deps, { tenantId: tenant, grantId: grant.id }).catch((e) => e);
    expect(err.code).toBe("mode-not-supported");
  });

  test("supplied revoke reports revocation-pending-operator and confirmSuppliedRevoked completes it", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    const out = await revokeGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(out.outcome).toBe("pending-operator");
    expect(out.grant.state).toBe("revoking");
    expect(out.grant.stateReason).toMatch(/^revocation-pending-operator/);
    expect(h.revoked).toHaveLength(0);
    expect(h.callsOf("forge.api.revoke")).toHaveLength(1);
    const done = await confirmSuppliedRevoked(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(done.grant.state).toBe("revoked");
  });

  test("confirming a supplied revoke while the wipe is still pending wipes first", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    h.replies["forge.api.revoke"] = () => ({ ok: false, error: "node offline" });
    const out = await revokeGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(out.grant.stateReason).toMatch(/^revocation-pending-operator.*wipe-pending/);
    const confirmed = await confirmSuppliedRevoked(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(confirmed.grant.state).toBe("revoking");
    expect(confirmed.grant.stateReason).toMatch(/^wipe-pending/);
    h.replies["forge.api.revoke"] = () => ({ ok: true, data: { removed: true } });
    expect((await revokeGrant(h.deps, { tenantId: tenant, grantId: grant.id })).grant.state).toBe("revoked");
  });

  test("confirmSuppliedRevoked refuses a minted grant", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    const err = await confirmSuppliedRevoked(h.deps, ref).catch((e) => e);
    expect(err.code).toBe("mode-not-supported");
  });

  test("app mode: registerAppGrant relays the sealed App key; revoke has nothing to revoke at the provider", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await registerAppGrant(h.deps, {
      ...input(st.id, { provider: "github", instance: "https://github.com", mode: "app", preset: "none", expectedLogin: "sjl-agents" }),
      sealed: OPAQUE,
    });
    expect(grant.state).toBe("delivered");
    expect(grant.account).toBe("sjl-agents");
    const frame = h.callsOf("forge.api.deliver")[0]!.params as { sealed: string; expectLogin: string; mode: string };
    expect(frame.sealed).toBe(OPAQUE);
    expect(frame.mode).toBe("app");
    expect(frame.expectLogin).toBe("sjl-agents[bot]");
    h.setLogin("sjl-agents[bot]");
    expect((await verifyGrant(h.deps, { tenantId: tenant, grantId: grant.id })).grant.state).toBe("verified");
    const out = await revokeGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(out.grant.state).toBe("revoked");
    expect(h.revoked).toHaveLength(0);
  });

  test("an app grant cannot be created with the [bot] suffix declared", async () => {
    const h = harness();
    const st = await freshStation();
    const err = await createForgeApiGrant(
      h.deps,
      input(st.id, { provider: "github", instance: "https://github.com", mode: "app", preset: "none", expectedLogin: "x[bot]" }),
    ).catch((e) => e);
    expect(err.code).toBe("bad-expected-login");
  });

  test("a mode the provider does not offer is refused (github cannot mint)", async () => {
    const h = harness();
    const st = await freshStation();
    const err = await createForgeApiGrant(
      h.deps,
      input(st.id, { provider: "github", instance: "https://github.com", mode: "minted" }),
    ).catch((e) => e);
    expect(err.code).toBe("mode-not-supported");
  });
});

// ─── policy ───────────────────────────────────────────────────────────────────

describe("updateGrantPolicy", () => {
  const rules = [{ deny: "DELETE /repos/*" }, { allow: "GET /repos/org/repo/issues", when: { label: "x" } }];

  test("updates the row and sends a validated policy frame with a positive ack", async () => {
    const h = harness();
    const { st, grant, ref } = await delivered(h);
    const out = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules, allowGraphql: true });
    expect(out.outcome).toBe("applied");
    expect(out.grant.preset).toBe("issues");
    expect(out.grant.rules).toEqual(rules);
    expect(out.grant.allowGraphql).toBe(true);
    expect(out.grant.state).toBe("delivered");
    expect(h.callsOf("forge.api.policy")[0]!.params).toEqual({
      stationId: st.id,
      grantId: grant.id,
      preset: "issues",
      rules,
      allowGraphql: true,
    });
  });

  test("malformed rules and unknown presets are refused before anything changes", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const bad: unknown[] = [
      { rules: [{ allow: "GET /x", deny: "GET /y" }] },
      { rules: [{}] },
      { rules: [{ allow: "FETCH /x" }] },
      { rules: [{ allow: "GET x" }] },
      { rules: [{ allow: "GET /x", token: "t" }] },
      { preset: "admin" },
    ];
    for (const b of bad) {
      const err = await updateGrantPolicy(h.deps, { ...ref, preset: "read", rules: [], allowGraphql: false, ...(b as object) } as never).catch(
        (e) => e,
      );
      expect(err.code).toBe("bad-policy");
      expect(err.status).toBe(422);
    }
    expect(h.callsOf("forge.api.policy")).toHaveLength(0);
    expect((await load(grant.id)).preset).toBe("read");
  });

  test("node offline: the policy is saved, flagged policy-pending, state unchanged", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.policy"] = () => ({ ok: false, error: "node offline" });
    const out = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false });
    expect(out.outcome).toBe("policy-pending");
    const row = await load(grant.id);
    expect(row.preset).toBe("issues");
    expect(row.state).toBe("delivered");
    expect(row.stateReason).toMatch(/^policy-pending/);
  });

  test("a negative policy ack is not success", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.replies["forge.api.policy"] = () => ({ ok: true, data: { ok: false, error: "bad rule" } });
    const out = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false });
    expect(out.outcome).toBe("policy-pending");
    expect(out.grant.stateReason).toMatch(/^policy-pending/);
  });

  test("a revoked grant's policy cannot change", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    await revokeGrant(h.deps, ref);
    const err = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false }).catch((e) => e);
    expect(err.code).toBe("grant-not-deliverable");
  });
});

// ─── Fix round 1 ──────────────────────────────────────────────────────────────

describe("rotation: pre-ack vs post-ack failures", () => {
  test("the hub checks the new token's identity before sealing; a mismatch is pre-ack: new revoked, row restored, node untouched", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.setCheckLogin("someone-else");
    await h.attempt(rotateGrant(h.deps, ref));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    expect(h.checked).toEqual([h.secrets.at(-1)!]);
    expect(h.callsOf("forge.api.deliver")).toHaveLength(0);
    expect(h.revoked.map((r) => r.handle)).toEqual([{ id: 501, name: `agentpod-${grant.id}-g2` }]);
    const row = await load(grant.id);
    expect(row.state).toBe("delivered");
    expect(row.generation).toBe(1);
    expect(row.tokenHandle).toEqual(grant.tokenHandle);
    expect(row.stateReason).toMatch(/^rotation-failed/);
    await assertNoLeak(h, grant.id);
  });

  test("acked but the node's verify is unreachable: neither token revoked, rotation-pending; a later verify revokes the old one", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const oldHandle = grant.tokenHandle!;
    h.replies["forge.api.verify"] = () => ({ ok: false, error: "timeout" });
    const out = await rotateGrant(h.deps, ref);
    expect(h.revoked).toHaveLength(0);
    expect(out.state).toBe("delivered");
    expect(out.stateReason).toMatch(/^rotation-pending/);
    expect(out.generation).toBe(2);
    expect(out.tokenHandle).toMatchObject({ id: 501, name: `agentpod-${grant.id}-g2`, previous: { ...oldHandle, disposition: "live-until-verified" } });
    // Acked: nothing left to re-deliver.
    expect(out.sealedBlob).toBeNull();

    h.replies["forge.api.verify"] = () => ({ ok: true, data: { ok: true, login: grant.account, isolation: "same-user" } });
    const v = await verifyGrant(h.deps, ref);
    expect(v.grant.state).toBe("verified");
    expect(h.revoked.map((r) => r.handle)).toEqual([oldHandle]);
    expect(v.grant.tokenHandle).toEqual({ id: 501, name: `agentpod-${grant.id}-g2` });
    expect(v.grant.stateReason).toBeNull();
    await assertNoLeak(h, grant.id);
  });

  test("ambiguous deliver (timeout): neither token revoked, the blob is kept, and verify re-delivers it before revoking the old one", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    const oldHandle = grant.tokenHandle!;
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "timeout" });
    const out = await rotateGrant(h.deps, ref);
    expect(h.revoked).toHaveLength(0);
    expect(out.stateReason).toMatch(/^rotation-pending/);
    expect(out.sealedBlob!.startsWith("stk-handover-v1:")).toBe(true);
    expect(out.sealedExpiresAt!.getTime()).toBe(h.deps.now().getTime() + DAY);
    expect(h.callsOf("forge.api.verify")).toHaveLength(0);
    const blob = out.sealedBlob;

    h.replies["forge.api.deliver"] = () => ACK;
    h.events.length = 0;
    const v = await verifyGrant(h.deps, ref);
    expect(v.grant.state).toBe("verified");
    expect(h.events).toEqual(["forge.api.deliver", "forge.api.verify", `revoke:${oldHandle.name}`]);
    expect((h.callsOf("forge.api.deliver").at(-1)!.params as { sealed: string }).sealed).toBe(blob!);
    expect(v.grant.sealedBlob).toBeNull();
    await assertNoLeak(h, grant.id);
  });

  test("ambiguous deliver: deliverGrant re-sends the kept blob", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const out = await rotateGrant(h.deps, ref);
    h.replies["forge.api.deliver"] = () => ACK;
    const d = await deliverGrant(h.deps, ref);
    expect(d.sealedBlob).toBeNull();
    expect((h.callsOf("forge.api.deliver").at(-1)!.params as { sealed: string }).sealed).toBe(out.sealedBlob!);
    expect(h.revoked).toHaveLength(0);
  });

  test("a refused deliver is pre-ack: new token revoked and the row restored", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "stk refused the envelope" });
    await h.attempt(rotateGrant(h.deps, ref));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    expect(h.revoked.map((r) => r.handle.name)).toEqual([`agentpod-${grant.id}-g2`]);
    expect((await load(grant.id)).tokenHandle).toEqual(grant.tokenHandle);
  });
});

describe("verify: provider unavailability is not a failure", () => {
  for (const reason of ["unreachable", "server-error: HTTP 502"]) {
    test(`node reports ${reason} → state unchanged, provider-unavailable`, async () => {
      const h = harness();
      const { ref } = await delivered(h);
      h.replies["forge.api.verify"] = () => ({ ok: true, data: { ok: false, reason, isolation: "same-user" } });
      const out = await verifyGrant(h.deps, ref);
      expect(out.outcome).toBe("provider-unavailable");
      expect((await load(ref.grantId)).state).toBe("delivered");
    });
  }
  for (const reason of ["unauthorized", "forbidden", "wrong-identity", "repository-missing: org/repo"]) {
    test(`node reports ${reason} → failed`, async () => {
      const h = harness();
      const { ref } = await delivered(h);
      h.replies["forge.api.verify"] = () => ({ ok: true, data: { ok: false, reason, isolation: "same-user" } });
      const out = await verifyGrant(h.deps, ref);
      expect(out.outcome).toBe("failed");
      expect(out.grant.state).toBe("failed");
    });
  }
});

describe("supplied re-supply", () => {
  test("re-supplying a verified grant clears verified_at (the new credential is unverified)", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    h.setLogin("machine-bot");
    expect((await verifyGrant(h.deps, { tenantId: tenant, grantId: grant.id })).grant.verifiedAt).not.toBeNull();
    const out = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: `${OPAQUE}-2` });
    expect(out.state).toBe("delivered");
    expect(out.verifiedAt).toBeNull();
  });

  test("a transient re-supply failure on a delivered grant is retried by deliverGrant with the live blob", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: OPAQUE });
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const next = `${OPAQUE}-2`;
    const kept = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: next });
    expect(kept.state).toBe("delivered");
    expect(kept.sealedBlob).toBe(next);
    h.replies["forge.api.deliver"] = () => ACK;
    const done = await deliverGrant(h.deps, { tenantId: tenant, grantId: grant.id });
    expect(done.sealedBlob).toBeNull();
    expect((h.callsOf("forge.api.deliver").at(-1)!.params as { sealed: string }).sealed).toBe(next);
  });

  test("the size cap message speaks of characters", async () => {
    const h = harness();
    const st = await freshStation();
    const grant = await createForgeApiGrant(h.deps, input(st.id, { mode: "supplied", expectedLogin: "machine-bot" }));
    const err = await acceptSuppliedSecret(h.deps, { tenantId: tenant, grantId: grant.id, sealed: "x" }).catch((e) => e);
    expect(err.message).toMatch(/characters/);
    expect(err.message).not.toMatch(/bytes/);
  });
});

describe("policy never clobbers a lifecycle reason", () => {
  test("a policy update during rotation-pending leaves rotation-pending intact", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.replies["forge.api.verify"] = () => ({ ok: false, error: "timeout" });
    await rotateGrant(h.deps, ref);
    h.replies["forge.api.policy"] = () => ({ ok: false, error: "node offline" });
    const out = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false });
    expect(out.outcome).toBe("policy-pending");
    expect(out.grant.preset).toBe("issues");
    expect(out.grant.stateReason).toMatch(/^rotation-pending/);
    h.replies["forge.api.policy"] = () => ({ ok: true, data: { ok: true } });
    const ok = await updateGrantPolicy(h.deps, { ...ref, preset: "read", rules: [], allowGraphql: false });
    expect(ok.outcome).toBe("applied");
    expect(ok.grant.stateReason).toMatch(/^rotation-pending/);
  });

  test("a policy-pending marker is cleared once the node applies the policy", async () => {
    const h = harness();
    const { ref } = await delivered(h);
    h.replies["forge.api.policy"] = () => ({ ok: false, error: "node offline" });
    await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false });
    h.replies["forge.api.policy"] = () => ({ ok: true, data: { ok: true } });
    const ok = await updateGrantPolicy(h.deps, { ...ref, preset: "issues", rules: [], allowGraphql: false });
    expect(ok.grant.stateReason).toBeNull();
  });
});

// ─── Fix round 2 ──────────────────────────────────────────────────────────────

const SNAP_COLS = ["state", "stateReason", "tokenHandle", "generation", "deliveredAt", "verifiedAt", "sealedBlob", "sealedExpiresAt"] as const;
/** Put a row back exactly as it was at a captured moment: a hub crash at that point. */
async function crashAt(snapshot: Grant) {
  const set: Record<string, unknown> = {};
  for (const c of SNAP_COLS) set[c] = snapshot[c];
  await db.update(g).set(set as never).where(eq(g.id, snapshot.id));
}

describe("rotation crash simulations", () => {
  test("(i) crash after recording n+1, before sealing: verify never revokes n; it undoes the unsealable rotation", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    let atSeal: Grant | undefined;
    const real = h.deps.seal;
    h.deps.seal = async (pk, m) => {
      atSeal = await load(grant.id);
      return real(pk, m);
    };
    await rotateGrant(h.deps, ref);
    await crashAt(atSeal!);
    expect(atSeal!.sealedBlob).toBeNull();
    expect(atSeal!.deliveredAt).toBeNull();
    h.revoked.length = 0;
    h.calls.length = 0;
    const out = await verifyGrant(h.deps, ref);
    // n (what the node holds) is never revoked; n+1 was never sealed, so it can never be
    // delivered: it is taken back and n is current again.
    expect(h.revoked.map((r) => r.handle)).toEqual([{ id: 501, name: `agentpod-${grant.id}-g2` }]);
    expect(h.callsOf("forge.api.verify")).toHaveLength(0);
    expect(out.outcome).toBe("rotation-failed");
    expect(out.grant.tokenHandle).toEqual(grant.tokenHandle);
    expect(out.grant.generation).toBe(1);
    expect(out.grant.deliveredAt).toEqual(grant.deliveredAt);
    expect(out.grant.stateReason).toMatch(/^rotation-failed/);
  });

  test("(ii) crash after the blob is persisted, before the ack: verify re-sends the blob first, then revokes n", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    let atDeliver: Grant | undefined;
    h.replies["forge.api.deliver"] = async () => {
      atDeliver = await load(grant.id);
      return ACK;
    };
    await rotateGrant(h.deps, ref);
    await crashAt(atDeliver!);
    expect(atDeliver!.sealedBlob).not.toBeNull();
    h.revoked.length = 0;
    h.events.length = 0;
    // A node that answers verify as the right account (n would, too) must not be believed before the ack.
    const out = await verifyGrant(h.deps, ref);
    expect(h.events).toEqual(["forge.api.deliver", "forge.api.verify", `revoke:${grant.tokenHandle!.name}`]);
    expect(out.grant.state).toBe("verified");
    expect(out.grant.sealedBlob).toBeNull();
  });

  test("(ii') same crash, node unreachable on re-send: n is not revoked and the blob stays", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    let atDeliver: Grant | undefined;
    h.replies["forge.api.deliver"] = async () => {
      atDeliver = await load(grant.id);
      return ACK;
    };
    await rotateGrant(h.deps, ref);
    await crashAt(atDeliver!);
    h.revoked.length = 0;
    h.calls.length = 0;
    h.replies["forge.api.deliver"] = () => ({ ok: false, error: "node offline" });
    const out = await verifyGrant(h.deps, ref);
    expect(out.outcome).toBe("node-offline");
    expect(h.revoked).toHaveLength(0);
    expect(h.callsOf("forge.api.verify")).toHaveLength(0);
    expect((await load(grant.id)).sealedBlob).toBe(atDeliver!.sealedBlob);
  });
});

describe("rotation: unreadable ack is ambiguous", () => {
  for (const reply of [{ ok: true, data: {} }, { ok: true }, { ok: true, data: { ok: "yes" } }] as Reply[]) {
    test(`deliver reply ${JSON.stringify(reply)} → nothing revoked, blob kept, rotation-pending`, async () => {
      const h = harness();
      const { grant, ref } = await delivered(h);
      h.replies["forge.api.deliver"] = () => reply;
      const out = await rotateGrant(h.deps, ref);
      expect(h.revoked).toHaveLength(0);
      expect(out.sealedBlob).not.toBeNull();
      expect(out.stateReason).toMatch(/^rotation-pending/);
      expect(out.tokenHandle!.previous).toMatchObject({ ...grant.tokenHandle!, disposition: "live-until-verified" });
    });
  }

  test("an explicit negative ack (ok:false) is a definite refusal: pre-ack", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.deliver"] = () => ({ ok: true, data: { ok: false, stored: false, isolation: "same-user" } });
    await h.attempt(rotateGrant(h.deps, ref));
    expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
    expect(h.revoked.map((r) => r.handle.name)).toEqual([`agentpod-${grant.id}-g2`]);
    const row = await load(grant.id);
    expect(row.tokenHandle).toEqual(grant.tokenHandle);
    expect(row.sealedBlob).toBeNull();
    expect(row.deliveredAt).toEqual(grant.deliveredAt);
  });
});

describe("rotation: a refused re-delivery is pre-ack", () => {
  for (const via of ["verifyGrant", "deliverGrant"] as const) {
    test(`${via}: the kept blob is refused → n+1 revoked, n current again, blob cleared, rotation-failed`, async () => {
      const h = harness();
      const { grant, ref } = await delivered(h);
      h.replies["forge.api.deliver"] = () => ({ ok: false, error: "timeout" });
      await rotateGrant(h.deps, ref);
      h.replies["forge.api.deliver"] = () => ({ ok: false, error: "stk refused the envelope" });
      if (via === "verifyGrant") await verifyGrant(h.deps, ref);
      else await deliverGrant(h.deps, ref);
      expect(h.revoked.map((r) => r.handle.name)).toEqual([`agentpod-${grant.id}-g2`]);
      const row = await load(grant.id);
      expect(row.tokenHandle).toEqual(grant.tokenHandle);
      expect(row.generation).toBe(1);
      expect(row.sealedBlob).toBeNull();
      expect(row.deliveredAt).toEqual(grant.deliveredAt);
      expect(row.state).toBe("delivered");
      expect(row.stateReason).toMatch(/^rotation-failed/);
    });
  }
});

describe("verify reason mapping (stk's codes)", () => {
  const verifyReply = (reason: string) => () => ({ ok: true, data: { ok: false, reason, isolation: "same-user" } });

  const outside: [string, string][] = [
    ["unauthorized", "failed"],
    ["forbidden", "failed"],
    ["wrong-identity", "failed"],
    ["repository-missing", "failed"],
    ["redirect", "failed"],
    ["unsupported", "failed"],
    ["unreachable", "provider-unavailable"],
    ["server-error", "provider-unavailable"],
    ["unexpected-response", "provider-unavailable"],
    ["something-new", "inconclusive"],
  ];
  for (const [code, outcome] of outside) {
    test(`outside a rotation: ${code} → ${outcome}`, async () => {
      const h = harness();
      const { ref } = await delivered(h);
      h.replies["forge.api.verify"] = verifyReply(`${code}: detail`);
      const out = await verifyGrant(h.deps, ref);
      expect(out.outcome).toBe(outcome as never);
      expect((await load(ref.grantId)).state).toBe(outcome === "failed" ? "failed" : "delivered");
      expect(h.revoked).toHaveLength(0);
    });
  }

  // [code, grant failed?, new token revoked?]
  const rotation: [string, boolean, boolean][] = [
    ["unauthorized", true, true],
    ["wrong-identity", true, true],
    ["forbidden", true, false],
    ["repository-missing", true, false],
    ["redirect", true, false],
    ["unsupported", true, false],
    ["unreachable", false, false],
    ["server-error", false, false],
    ["unexpected-response", false, false],
    ["something-new", false, false],
  ];
  for (const [code, fails, revokesNew] of rotation) {
    test(`after a rotation's ack: ${code} → ${fails ? "failed" : "rotation-pending"}${revokesNew ? ", new token revoked" : ""}`, async () => {
      const h = harness();
      const { grant, ref } = await delivered(h);
      const oldHandle = grant.tokenHandle!;
      const newHandle = { id: 501, name: `agentpod-${grant.id}-g2` };
      h.replies["forge.api.verify"] = verifyReply(`${code}: detail`);
      await h.attempt(rotateGrant(h.deps, ref));
      const row = await load(grant.id);
      if (fails) {
        expect((h.errors[0] as ForgeApiGrantError).code).toBe("rotation-failed");
        expect(row.state).toBe("failed");
        expect(row.stateReason).toMatch(/^rotation-failed/);
        // Gap A: n is superseded once the node acked n+1 — revoked now (best effort).
        expect(h.revoked.map((r) => r.handle)).toEqual(revokesNew ? [newHandle, oldHandle] : [oldHandle]);
        expect(row.tokenHandle!.previous).toBeUndefined();
      } else {
        expect(h.errors).toHaveLength(0);
        expect(row.state).toBe("delivered");
        expect(row.stateReason).toMatch(/^rotation-pending/);
        expect(h.revoked).toHaveLength(0);
        expect(row.tokenHandle!.previous).toMatchObject({ ...oldHandle, disposition: "live-until-verified" });
      }
    });
  }

  test("after an ack, a definitive failure whose n-revoke fails leaves previous with disposition revoke", async () => {
    const h = harness();
    const { grant, ref } = await delivered(h);
    h.replies["forge.api.verify"] = verifyReply("forbidden");
    h.provider.revoke = async () => {
      throw new Error("forge: revoking was refused (HTTP 503).");
    };
    await h.attempt(rotateGrant(h.deps, ref));
    const row = await load(grant.id);
    expect(row.tokenHandle!.previous).toMatchObject({ ...grant.tokenHandle!, disposition: "revoke" });
  });
});
