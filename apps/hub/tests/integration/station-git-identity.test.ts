/**
 * The key a station pushes with — provisioned by an operator, generated on the node.
 *
 * What is asserted hardest is what the hub never carries and what it refuses to ask for. The happy
 * path shows none of it: a design that quietly shipped a private key through the broker, or minted
 * a keypair it then could not register, would pass a test that only checked for a 200.
 *
 * Uses a real fake node over the actual gateway websocket rather than a stubbed broker, so the
 * verb, its params and the offline mapping are the real ones.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { stationGitIdentities } from "../../src/db/schema/git-identities";
import { stations } from "../../src/db/schema/stations";
import { stationAudit } from "../../src/db/schema/audit";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser, deleteTestUser } from "../helpers/database";
import { waitForNodeOnline } from "../helpers/wait";
import { enrollNode, mintEnrollmentToken } from "../../src/services/enrollment";
import { createPrincipal, forgetPrincipals } from "../helpers/principals";
import { createStationGitIdentityRoutes } from "../../src/routes/station-git-identity";
import { gatewayRoutes } from "../../src/routes/gateway";
import { stationRoutes } from "../../src/routes/stations";
import { configureGitAuthorSync, keyTitleFor } from "../../src/services/station-git-identity";
import { websocket } from "../../src/ws";
import type { ForgeConfig } from "../../src/services/forge";
import type { AuthUser } from "../../src/auth/middleware";
import type { StationRow } from "../../src/services/station-registry";

const RUN = crypto.randomUUID().slice(0, 8);
const cfg: ForgeConfig = { baseUrl: "https://forge.test", adminToken: "admin" };

const TEST_USER = `usr_gitid_${RUN}`;
const OTHER_USER = `usr_gitid_other_${RUN}`;

/**
 * One agent per test, not one for the file: `stations_principal_id_idx` is UNIQUE, so a principal
 * occupies at most one station. Sharing one would make every test after the first fail on the
 * insert rather than on anything it meant to assert.
 */
const handles: string[] = [];
async function freshAgent(displayName?: string): Promise<{ id: string; handle: string }> {
  const handle = `coder-kai-${RUN}-${handles.length}`;
  handles.push(handle);
  // createPrincipal returns the id itself, not a row.
  return { id: await createPrincipal({ kind: "agent", handle, displayName }), handle };
}

/** The address the forge stub gives an account — deliberately NOT the hub's own convention, so a
 * test can tell the email forge returned from one the hub made up. */
const forgeEmail = (login: string) => `${login}@forge-assigned.example`;

/** What the fake node hands back. Two, so rotation can be seen to change something. */
const KEY_A =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPqRVGcqJWmS1Wc4o9xY3n5m6z8dKQfQfQfQfQfQfQfQ station-a";
const KEY_B =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB station-b";

// ─── Forge stub ───────────────────────────────────────────────────────────────

/** A forge that answers as though the account existed and keys register cleanly. */
function forgeStub(startId = 100) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let nextId = startId;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.replace(cfg.baseUrl + "/api/v1", "")}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    if (url.endsWith("/keys") && method === "POST") {
      const asked = init?.body
        ? (JSON.parse(String(init.body)) as { title?: string }).title
        : undefined;
      return new Response(JSON.stringify({ id: nextId++, title: asked ?? "" }), { status: 201 });
    }
    if (url.includes("/users/") && method === "GET") {
      // Echo the login that was asked for. A stub answering with a FIXED name once hid that the
      // account is derived from the station's principal, not from the request.
      const login = decodeURIComponent(url.split("/users/")[1]!.split("/")[0]!);
      return new Response(
        JSON.stringify({ id: 3, login, email: forgeEmail(login), full_name: `${login} (agent)` }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 204 });
  };
  return { fetchImpl, calls, bodies };
}

// ─── Test app ─────────────────────────────────────────────────────────────────

function appFor(deps: { forge: ForgeConfig | null; fetchImpl?: typeof fetch }) {
  return new Hono()
    .use("/api/*", async (c, next) => {
      const userId = c.req.header("X-Test-User-Id") ?? "anonymous";
      c.set("user", {
        id: userId,
        authType: "api_key",
        tenantId: "fleet_00000000000000000000",
      } satisfies AuthUser);
      return next();
    })
    .route("/public/nodes", gatewayRoutes)
    .route("/api", createStationGitIdentityRoutes(deps as Parameters<typeof createStationGitIdentityRoutes>[0]))
    .route("/api", stationRoutes);
}

// ─── Fake node ────────────────────────────────────────────────────────────────

/**
 * A node that answers detect plus the two git identity verbs.
 *
 * `keys` is a queue: the first ensure gets the first entry, so rotation can hand back a genuinely
 * different key. `refuse` makes both verbs answer ok:false.
 */
async function connectFakeNode(opts: {
  port: number;
  nodeId: string;
  nodeSecret: string;
  stationKey: string;
  keys: string[];
  refuse?: string;
  captured: string[];
}): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${opts.port}/public/nodes/gateway`, {
    headers: { Authorization: `Bearer ${opts.nodeId}:${opts.nodeSecret}` },
  } as RequestInit & { headers: Record<string, string> });

  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("Node WS connection error"));
  });

  const queue = [...opts.keys];
  let held: string | undefined;
  ws.onmessage = (e) => {
    const raw = String(e.data);
    opts.captured.push(raw);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "req") return;
    const fail = () =>
      ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: opts.refuse }));

    switch (msg.verb) {
      case "detect":
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: [
              {
                key: opts.stationKey,
                harness: "codex",
                kind: "leaf",
                displayName: `Test Station (${opts.stationKey})`,
                parentKey: null,
                workspacePath: `/workspace/${opts.stationKey}`,
                capabilities: ["health", "changeset"],
              },
            ],
          }),
        );
        break;
      case "git.identity.ensure": {
        if (opts.refuse) return fail();
        // An ensure that only delivers an author gets the key the node already holds, as a real
        // node's would; the queue models what a provisioning ensure hands back.
        const carriesAuthor = Boolean((msg.params as { author?: unknown } | undefined)?.author);
        const key = carriesAuthor ? (held ?? KEY_A) : (queue.shift() ?? KEY_A);
        held = key;
        ws.send(
          JSON.stringify({
            type: "res",
            id: msg.id,
            ok: true,
            data: { publicKey: key, created: true },
          }),
        );
        break;
      }
      case "git.identity.remove":
        if (opts.refuse) return fail();
        ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, data: { removed: true } }));
        break;
    }
  };

  await waitForNodeOnline(opts.nodeId);
  return ws;
}

async function adoptStation(baseUrl: string, nodeId: string, stationKey: string) {
  const res = await fetch(`${baseUrl}/api/nodes/${nodeId}/stations/adopt`, {
    method: "POST",
    headers: { "X-Test-User-Id": TEST_USER, "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [stationKey] }),
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as StationRow[];
  return rows[0]!;
}

/**
 * Boots a server with a station adopted and, unless `withoutPrincipal`, an agent on it.
 *
 * Adoption does not place a principal — that is a separate act — so the occupied case is arranged
 * here rather than assumed.
 */
async function withStation(opts: {
  forge?: ForgeConfig | null;
  fetchImpl?: typeof fetch;
  keys?: string[];
  refuse?: string;
  withoutPrincipal?: boolean;
  displayName?: string;
}) {
  const server = Bun.serve({
    fetch: appFor({
      forge: opts.forge === undefined ? cfg : opts.forge,
      fetchImpl: opts.fetchImpl,
    }).fetch,
    websocket,
    port: 0,
  });
  const baseUrl = `http://localhost:${server.port}`;
  const stationKey = `gitid-${crypto.randomUUID().slice(0, 8)}`;
  const captured: string[] = [];

  const { token } = await mintEnrollmentToken(TEST_USER);
  const { nodeId, nodeSecret } = await enrollNode(token, {
    hostname: `gitid-host-${stationKey}`,
    os: "linux",
    arch: "amd64",
    cpuCount: 2,
  });

  const fakeNode = await connectFakeNode({
    port: server.port!,
    nodeId,
    nodeSecret,
    stationKey,
    keys: opts.keys ?? [KEY_A],
    refuse: opts.refuse,
    captured,
  });

  const station = await adoptStation(baseUrl, nodeId, stationKey);
  let handle = "";
  if (!opts.withoutPrincipal) {
    const agent = await freshAgent(opts.displayName);
    handle = agent.handle;
    await db.update(stations).set({ principalId: agent.id }).where(eq(stations.id, station.id));
  }

  const reconnect = async (captured2: string[]) =>
    connectFakeNode({ port: server.port!, nodeId, nodeSecret, stationKey, keys: opts.keys ?? [KEY_A], captured: captured2 });

  return { server, baseUrl, station, stationKey, captured, fakeNode, nodeId, handle, reconnect };
}

function sawVerb(msgs: string[], verb: string): boolean {
  return msgs.some((raw) => {
    try {
      const m = JSON.parse(raw);
      return m?.type === "req" && m?.verb === verb;
    } catch {
      return false;
    }
  });
}

function reqsFor(msgs: string[], verb: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const raw of msgs) {
    try {
      const m = JSON.parse(raw);
      if (m?.type === "req" && m?.verb === verb) out.push(m.params as Record<string, unknown>);
    } catch {
      // not JSON — skip
    }
  }
  return out;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function reqFor(msgs: string[], verb: string): Record<string, unknown> | undefined {
  for (const raw of msgs) {
    try {
      const m = JSON.parse(raw);
      if (m?.type === "req" && m?.verb === verb) return m.params as Record<string, unknown>;
    } catch {
      // not JSON — skip
    }
  }
  return undefined;
}

const call = (baseUrl: string, stationId: string, method: string, user = TEST_USER) =>
  fetch(`${baseUrl}/api/stations/${stationId}/git-identity`, {
    method,
    headers: { "X-Test-User-Id": user, "Content-Type": "application/json" },
  });

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({
    id: TEST_USER,
    email: `station-git-identity-${RUN}@example.com`,
    name: "Station Git Identity Test User",
  });
  await createTestUser({
    id: OTHER_USER,
    email: `station-git-identity-other-${RUN}@example.com`,
    name: "Station Git Identity Other User",
  });
});

afterAll(async () => {
  for (const u of [TEST_USER, OTHER_USER]) {
    try {
      await rawSql`DELETE FROM station_git_identities WHERE station_id IN (SELECT id FROM stations WHERE user_id = ${u})`;
      await rawSql`DELETE FROM station_audit     WHERE user_id = ${u}`;
      await rawSql`DELETE FROM stations          WHERE user_id = ${u}`;
      await rawSql`DELETE FROM nodes             WHERE user_id = ${u}`;
      await rawSql`DELETE FROM enrollment_tokens WHERE user_id = ${u}`;
      await deleteTestUser(u);
    } catch {
      // ignore
    }
  }
  for (const h of handles) {
    try {
      await forgetPrincipals({ handles: [h] });
    } catch {
      // ignore
    }
  }
});

// ─── Provisioning ─────────────────────────────────────────────────────────────

describe("provisioning", () => {
  test("asks the node for a public key and registers it under the station's agent", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { username: string; keyId: number; rotated: boolean };

      // Derived from the station's principal, never from the request.
      expect(body.username).toBe(ctx.handle);
      expect(body.rotated).toBe(false);

      expect(sawVerb(ctx.captured, "git.identity.ensure")).toBe(true);
      // Both names of the station and nothing more. In particular NOT the account: a node that
      // could be told which account to use could have its key registered against another agent.
      expect(reqFor(ctx.captured, "git.identity.ensure")).toEqual({
        stationId: ctx.station.id,
        stationKey: ctx.stationKey,
      });

      const [row] = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(row!.keyId).toBe(body.keyId);
      expect(row!.publicKey).toBe(KEY_A);
      expect(row!.username).toBe(ctx.handle);

      // The key is titled after the station, so an account with several can be pruned.
      expect(forge.bodies.some((b) => (b as { title?: string }).title === keyTitleFor(ctx.station.id))).toBe(true);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("no secret crosses the broker or reaches the database", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(200);

      // The whole design in two assertions: nothing private on the wire, every column public.
      const wire = ctx.captured.join("\n") + JSON.stringify(await res.json());
      expect(wire).not.toContain("PRIVATE KEY");
      expect(/"(privateKey|keyPath)"/.test(wire)).toBe(false);

      const [row] = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(Object.keys(row!).some((k) => /token|secret|private/i.test(k))).toBe(false);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("granting push access leaves an audit row even though reading status does not", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST")).status).toBe(200);
      const rows = await db
        .select()
        .from(stationAudit)
        .where(eq(stationAudit.stationKey, ctx.stationKey));
      expect(rows.map((r) => r.verb)).toContain("git.identity.ensure");
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("provisioning twice rotates: the old key is deleted before the new one is added", async () => {
    const forge = forgeStub();
    const ctx = await withStation({
      fetchImpl: forge.fetchImpl as unknown as typeof fetch,
      keys: [KEY_A, KEY_B],
    });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST")).status).toBe(200);
      const second = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(second.status).toBe(200);
      expect(((await second.json()) as { rotated: boolean }).rotated).toBe(true);

      const [row] = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(row!.publicKey).toBe(KEY_B);
      expect(row!.rotatedAt).not.toBeNull();

      // Deleted before added, so a station is never able to push with a key the row does not name.
      const del = forge.calls.findIndex((c) => c.startsWith("DELETE"));
      const lastAdd = forge.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith("POST") && c.endsWith("/keys")).at(-1)![1];
      expect(del).toBeGreaterThan(-1);
      expect(del).toBeLessThan(lastAdd);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("GET reports what the station can push as, and null when it cannot", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      const before = await call(ctx.baseUrl, ctx.station.id, "GET");
      expect(((await before.json()) as { identity: unknown }).identity).toBeNull();

      await call(ctx.baseUrl, ctx.station.id, "POST");
      const after = await call(ctx.baseUrl, ctx.station.id, "GET");
      const { identity } = (await after.json()) as {
        identity: { username: string; keyId: number };
      };
      expect(identity.username).toBe(ctx.handle);
      expect(identity.keyId).toBeGreaterThan(0);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });
});

// ─── Refusals ─────────────────────────────────────────────────────────────────

describe("refusals", () => {
  test("a station with no agent on it is refused WITHOUT asking the node", async () => {
    // The order matters more than the status: a keypair minted for an account that does not exist
    // is a private key on disk with nothing to push to and no record anywhere that it was made.
    const forge = forgeStub();
    const ctx = await withStation({
      fetchImpl: forge.fetchImpl as unknown as typeof fetch,
      withoutPrincipal: true,
    });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(409);
      expect(sawVerb(ctx.captured, "git.identity.ensure")).toBe(false);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("a hub with no forge credential says so WITHOUT asking the node", async () => {
    const ctx = await withStation({ forge: null });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(503);
      expect(sawVerb(ctx.captured, "git.identity.ensure")).toBe(false);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("anonymous is 401 and another user's station is 404", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST", "anonymous")).status).toBe(401);
      expect((await call(ctx.baseUrl, ctx.station.id, "POST", OTHER_USER)).status).toBe(404);
      expect(forge.calls).toHaveLength(0);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("a node that cannot generate a key is 502, and nothing is registered", async () => {
    const forge = forgeStub();
    const ctx = await withStation({
      fetchImpl: forge.fetchImpl as unknown as typeof fetch,
      refuse: "ssh-keygen not found",
    });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(502);
      expect(forge.calls).toHaveLength(0);
      const rows = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(rows).toHaveLength(0);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("an offline node is 409, not 502 — it is a state that resolves on its own", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    ctx.fakeNode.close();
    try {
      // The socket's close has to land on the hub before the broker knows.
      let status = 0;
      for (let i = 0; i < 40 && status !== 409; i++) {
        status = (await call(ctx.baseUrl, ctx.station.id, "POST")).status;
        if (status !== 409) await new Promise((r) => setTimeout(r, 50));
      }
      expect(status).toBe(409);
    } finally {
      ctx.server.stop(true);
    }
  });
});

// ─── Withdrawal ───────────────────────────────────────────────────────────────

describe("withdrawal", () => {
  test("deletes the key on forge, drops the row, and tells the node to delete its file", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST")).status).toBe(200);

      const res = await call(ctx.baseUrl, ctx.station.id, "DELETE");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true, nodeCleaned: true });

      expect(forge.calls.some((c) => c.startsWith("DELETE"))).toBe(true);
      const rows = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(rows).toHaveLength(0);

      // Without this the node would hand the same key to whichever agent occupies the station next.
      expect(sawVerb(ctx.captured, "git.identity.remove")).toBe(true);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("an offline node does not fail a withdrawal — the revoked key is already useless", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST")).status).toBe(200);
      ctx.fakeNode.close();

      let body = { revoked: false, nodeCleaned: true };
      for (let i = 0; i < 40 && body.nodeCleaned; i++) {
        const res = await call(ctx.baseUrl, ctx.station.id, "DELETE");
        expect(res.status).toBe(200);
        body = (await res.json()) as typeof body;
        if (body.nodeCleaned) await new Promise((r) => setTimeout(r, 50));
      }
      // Reported, not hidden: the operator needs to know a key file outlived its registration.
      expect(body.nodeCleaned).toBe(false);
    } finally {
      ctx.server.stop(true);
    }
  });

  test("withdrawing from a station that has no identity is not an error", async () => {
    const forge = forgeStub();
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "DELETE");
      expect(res.status).toBe(200);
      expect(((await res.json()) as { revoked: boolean }).revoked).toBe(false);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });
});

// ─── Commit author ────────────────────────────────────────────────────────────

describe("commit author", () => {
  test("after registering, the node is told who the station's commits are by", async () => {
    const forge = forgeStub();
    const ctx = await withStation({
      fetchImpl: forge.fetchImpl as unknown as typeof fetch,
      displayName: "fixture-agent",
    });
    try {
      const res = await call(ctx.baseUrl, ctx.station.id, "POST");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { author: { name: string; email: string } | null; authorDelivered: boolean };
      const want = { name: "Fixture Agent", email: forgeEmail(ctx.handle) };
      expect(body.author).toEqual(want);
      expect(body.authorDelivered).toBe(true);

      // The author rides in an ensure, so a node that predates it ignores the field and keeps working.
      const withAuthor = reqsFor(ctx.captured, "git.identity.ensure").filter((p) => p.author);
      expect(withAuthor).toHaveLength(1);
      expect(withAuthor[0]).toEqual({ stationId: ctx.station.id, stationKey: ctx.stationKey, author: want });

      const [row] = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      expect(row!.authorName).toBe(want.name);
      expect(row!.authorEmail).toBe(want.email);

      // And the operator can see it.
      const shown = (await (await call(ctx.baseUrl, ctx.station.id, "GET")).json()) as {
        identity: { authorName: string; authorEmail: string };
      };
      expect(shown.identity.authorName).toBe(want.name);
      expect(shown.identity.authorEmail).toBe(want.email);
    } finally {
      ctx.fakeNode.close();
      ctx.server.stop(true);
    }
  });

  test("an identity from before authors existed is backfilled on reconnect, without touching its key", async () => {
    const forge = forgeStub();
    configureGitAuthorSync({ forge: cfg, fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    const ctx = await withStation({
      fetchImpl: forge.fetchImpl as unknown as typeof fetch,
      displayName: "fixture-agent",
    });
    try {
      expect((await call(ctx.baseUrl, ctx.station.id, "POST")).status).toBe(200);
      // What a row provisioned by the previous release looks like.
      await db
        .update(stationGitIdentities)
        .set({ authorName: null, authorEmail: null })
        .where(eq(stationGitIdentities.stationId, ctx.station.id));
      const [before] = await db
        .select()
        .from(stationGitIdentities)
        .where(eq(stationGitIdentities.stationId, ctx.station.id));

      ctx.fakeNode.close();
      const forgeCallsBefore = forge.calls.length;
      const captured2: string[] = [];
      const node2 = await ctx.reconnect(captured2);
      try {
        const delivered = await until(() =>
          reqsFor(captured2, "git.identity.ensure").some((p) => p.author),
        );
        expect(delivered).toBe(true);
        const [sent] = reqsFor(captured2, "git.identity.ensure").filter((p) => p.author);
        expect(sent).toEqual({
          stationId: ctx.station.id,
          stationKey: ctx.stationKey,
          author: { name: "Fixture Agent", email: forgeEmail(ctx.handle) },
        });

        expect(
          await until(async () => {
            const [r] = await db
              .select()
              .from(stationGitIdentities)
              .where(eq(stationGitIdentities.stationId, ctx.station.id));
            return r!.authorEmail === forgeEmail(ctx.handle);
          }),
        ).toBe(true);

        // No re-provisioning: forge was only READ, and the row still names the same key.
        const since = forge.calls.slice(forgeCallsBefore);
        expect(since.every((c) => c.startsWith("GET "))).toBe(true);
        const [after] = await db
          .select()
          .from(stationGitIdentities)
          .where(eq(stationGitIdentities.stationId, ctx.station.id));
        expect(after!.keyId).toBe(before!.keyId);
        expect(after!.publicKey).toBe(before!.publicKey);
      } finally {
        node2.close();
      }
    } finally {
      configureGitAuthorSync(null);
      ctx.server.stop(true);
    }
  });

  test("a reconnecting node whose stations have no identity is asked nothing", async () => {
    const forge = forgeStub();
    configureGitAuthorSync({ forge: cfg, fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    const ctx = await withStation({ fetchImpl: forge.fetchImpl as unknown as typeof fetch });
    try {
      ctx.fakeNode.close();
      const captured2: string[] = [];
      const node2 = await ctx.reconnect(captured2);
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(sawVerb(captured2, "git.identity.ensure")).toBe(false);
        expect(forge.calls).toHaveLength(0);
      } finally {
        node2.close();
      }
    } finally {
      configureGitAuthorSync(null);
      ctx.server.stop(true);
    }
  });
});
