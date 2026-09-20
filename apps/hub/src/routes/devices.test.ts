/**
 * Route + service tests: the device credential a human exchanges at a terminal.
 *
 * `charter → decisions/2026-09-18-a-human-at-a-terminal-has-nothing-to-exchange.md`,
 * accepted 2026-09-20. What is proven here is mostly refusal, because this is a
 * ninety-day credential and every way of getting one wrong is worse than the
 * five-minute problem it replaces:
 *
 *   1. The happy path mints a token whose claims come from `buildTokenPayload`
 *      and which carries `amr: ["device"]` — the mark superpipeline reads to refuse
 *      turning it into a thirty-day session.
 *   2. **A device token cannot mint another device credential.** The one that is
 *      easy to miss: without it, revoking a stolen credential accomplishes
 *      nothing, because whoever took it already minted a replacement that was
 *      never on the list the operator was reading.
 *   3. An agent-kind token cannot mint one either.
 *   4. Revoked, expired, wrong-secret and unknown all refuse **identically** —
 *      a caller able to tell them apart can probe for device ids.
 *   5. Revocation is scoped to the owner, so this endpoint cannot enumerate.
 *   6. The expiry slides on use, which is what makes 90 days ergonomic rather
 *      than a cliff.
 *
 * Uses the local Docker test-postgres (localhost:5434). Every fixture id is
 * unique per run and `afterAll` deletes what it created, so this passes on a
 * fresh database and on a second run against the same one.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { decodeJwt } from "jose";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";

import { db, rawSql } from "../db/drizzle";
import { deviceCredentials } from "../db/schema/devices";
import { BOOTSTRAP_TENANT_ID } from "../db/schema/tenants";
import { ensurePgMigrations } from "../../tests/helpers/pg-migrations";
import { createTestUser } from "../../tests/helpers/database";
import { createPrincipal } from "../services/principals";
import {
  exchangeDeviceCredential,
  mintDeviceCredential,
  revokeDeviceCredential,
  listDeviceCredentials,
  DEVICE_CREDENTIAL_TTL_MS,
} from "../services/device-credentials";
import { deviceRoutes } from "./devices";

const RUN = crypto.randomUUID().slice(0, 8);
const app = new Hono().route("/api/auth", deviceRoutes);

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  await ensurePgMigrations();
  const u = await createTestUser({ id: `dev-user-${RUN}`, email: `dev-${RUN}@example.com` });
  const o = await createTestUser({ id: `dev-other-${RUN}`, email: `devo-${RUN}@example.com` });
  userId = u.id;
  otherUserId = o.id;
  // A principal, because `buildTokenPayload` refuses to mint for a user that has none.
  await createPrincipal({ userId, kind: "human", handle: `devhandle${RUN}` });
});

afterAll(async () => {
  await rawSql`DELETE FROM device_credentials WHERE user_id IN (${userId}, ${otherUserId})`;
});

/** Exchange over the route, as the CLI would. */
async function exchangeOverHttp(id: string, secret: string) {
  return app.request("/api/auth/devices/token", {
    method: "POST",
    headers: { Authorization: `Bearer ${id}:${secret}` },
  });
}

async function mintFor(uid = userId, name = "this-laptop") {
  return mintDeviceCredential({ userId: uid, tenantId: BOOTSTRAP_TENANT_ID, name });
}

describe("exchanging a device credential", () => {
  test("mints a five-minute token marked as device-authenticated", async () => {
    const device = await mintFor();
    const res = await exchangeOverHttp(device.id, device.secret);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { token: string; expiresIn: number; device: { id: string } };
    expect(body.device.id).toBe(device.id);
    expect(body.expiresIn).toBe(300);

    const claims = decodeJwt(body.token) as Record<string, unknown>;
    // The mark superpipeline reads. Without it a stolen 0600 file becomes a
    // thirty-day session cookie in the other plane.
    expect(claims.amr).toEqual(["device"]);
    // Claims came from buildTokenPayload — a human principal, not hand-assembled.
    expect(claims.principalKind).toBe("human");
    expect(claims.sub).toBe(userId);
    // Five minutes, the same TTL every other hub token gets.
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
  });

  test("slides the expiry forward, so sustained work never meets it", async () => {
    const device = await mintFor();
    await db
      .update(deviceCredentials)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(deviceCredentials.id, device.id));

    expect(await exchangeDeviceCredential(device.id, device.secret)).not.toBeNull();

    const [row] = await db.select().from(deviceCredentials).where(eq(deviceCredentials.id, device.id));
    // Back to the full window, and last_used_at now says so.
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + DEVICE_CREDENTIAL_TTL_MS - 60_000);
    expect(row!.lastUsedAt).not.toBeNull();
  });

  test("refuses a revoked, an expired, a wrong-secret and an unknown device identically", async () => {
    // The collapse is the test. A caller who can tell "no such device" from
    // "that device was revoked" can probe for ids — and a revoked device is
    // exactly where that would pay whoever took the laptop.
    const revoked = await mintFor();
    await revokeDeviceCredential(userId, revoked.id);

    const expired = await mintFor();
    await db
      .update(deviceCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceCredentials.id, expired.id));

    const live = await mintFor();

    const answers = await Promise.all([
      exchangeOverHttp(revoked.id, revoked.secret),
      exchangeOverHttp(expired.id, expired.secret),
      exchangeOverHttp(live.id, "the-wrong-secret"),
      exchangeOverHttp("dev_nosuchdevice00000", "whatever"),
      exchangeOverHttp("", ""),
    ]);

    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid device credential" });
    }

    // And the live one still works — without this the file passes for an
    // endpoint that refuses everything.
    expect((await exchangeOverHttp(live.id, live.secret)).status).toBe(200);
  });
});

describe("a device token may not mint another device credential", () => {
  test("the exchanged token is refused by POST /devices", async () => {
    // THE refusal. Without it, revoking a stolen credential accomplishes
    // nothing: the thief mints a replacement that was never on the operator's
    // list, and it outlives the revocation of the one that was.
    const device = await mintFor();
    const exchanged = await exchangeOverHttp(device.id, device.secret);
    const { token } = (await exchanged.json()) as { token: string };

    const res = await app.request("/api/auth/devices", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "a second laptop" }),
    });

    expect(res.status).toBe(401);
    // And nothing was created.
    const mine = await listDeviceCredentials(userId);
    expect(mine.some((d) => d.name === "a second laptop")).toBe(false);
  });

  test("and so are listing and revoking, which would otherwise map the inventory", async () => {
    const device = await mintFor();
    const exchanged = await exchangeOverHttp(device.id, device.secret);
    const { token } = (await exchanged.json()) as { token: string };
    const auth = { Authorization: `Bearer ${token}` };

    expect((await app.request("/api/auth/devices", { headers: auth })).status).toBe(401);
    expect(
      (await app.request(`/api/auth/devices/${device.id}`, { method: "DELETE", headers: auth })).status,
    ).toBe(401);
  });
});

describe("revocation", () => {
  test("is scoped to the owner, so the endpoint cannot enumerate", async () => {
    const mine = await mintFor(userId);
    // Somebody else's device: revoking it must answer exactly as a device that
    // does not exist does, or this route is a membership oracle for the table.
    const theirs = await mintFor(otherUserId, "their-laptop");

    expect(await revokeDeviceCredential(userId, theirs.id)).toBe(false);
    expect(await revokeDeviceCredential(userId, "dev_doesnotexist0000")).toBe(false);
    expect(await revokeDeviceCredential(userId, mine.id)).toBe(true);

    // Theirs is untouched and still exchangeable.
    expect(await exchangeDeviceCredential(theirs.id, theirs.secret)).not.toBeNull();
  });

  test("is idempotent, and leaves the device visible in the list it was revoked from", async () => {
    const device = await mintFor();
    expect(await revokeDeviceCredential(userId, device.id)).toBe(true);
    expect(await revokeDeviceCredential(userId, device.id)).toBe(false);

    const listed = (await listDeviceCredentials(userId)).find((d) => d.id === device.id);
    expect(listed).toBeDefined();
    expect(listed!.revokedAt).not.toBeNull();
  });
});

describe("the secret", () => {
  test("is never returned again, by any route", async () => {
    const device = await mintFor();
    const listed = await listDeviceCredentials(userId);
    const row = listed.find((d) => d.id === device.id)!;
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(device.secret);
    // And the stored form is a hash, not the secret.
    const [stored] = await db.select().from(deviceCredentials).where(eq(deviceCredentials.id, device.id));
    expect(stored!.secretHash).not.toBe(device.secret);
    expect(stored!.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Where these routes are MOUNTED, which is the part the tests above cannot see.
 *
 * Every test in this file mounts `deviceRoutes` on a bare Hono app. That is the
 * right shape for testing what the routes do — and it is exactly why all eight
 * passed while every one of these paths answered **404 in production** on
 * 2026-09-20.
 *
 * `index.ts` registers `.on(['GET','POST'], '/api/auth/*', …)` for Better Auth,
 * and Hono matches in registration order: anything mounted under `/api/auth`
 * after that line is swallowed. The device routes shipped below it. The comment
 * on the mount even cited the warning it was violating.
 *
 * So this reads the source and asserts the order, the same way
 * `cmd/agentpod-fleet/main_test.go` reads `fleet.go`'s switch. A structural test
 * for a structural invariant: what breaks is not a handler's behaviour but where
 * it sits in a list.
 */
describe("the device routes are mounted where they can be reached", () => {
  // Read synchronously: `describe` bodies are not async, and this is a file on disk.
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

  test("above Better Auth's /api/auth/* catch-all", () => {
    const mount = source.indexOf(".route('/api/auth', deviceRoutes)");
    const catchAll = source.indexOf(".on(['GET', 'POST'], '/api/auth/*'");

    expect(mount, "deviceRoutes is not mounted in index.ts at all").toBeGreaterThan(-1);
    expect(catchAll, "the Better Auth catch-all moved or changed shape — re-read this test").toBeGreaterThan(-1);
    expect(
      mount,
      "deviceRoutes is mounted AFTER Better Auth's /api/auth/* catch-all, which swallows it — every device path will 404",
    ).toBeLessThan(catchAll);
  });

  test("above authMiddleware, which would 401 a dev_… credential", () => {
    const mount = source.indexOf(".route('/api/auth', deviceRoutes)");
    const middleware = source.indexOf(".use('/api/*', authMiddleware)");

    expect(middleware).toBeGreaterThan(-1);
    expect(
      mount,
      "deviceRoutes is behind authMiddleware, which accepts no dev_… credential and no hub JWT",
    ).toBeLessThan(middleware);
  });
});
