process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/drizzle";
import { hubOperators } from "../../src/db/schema/operators";
import { user } from "../../src/db/schema/auth";
import { ensurePgMigrations } from "../helpers/pg-migrations";
import { createTestUser } from "../helpers/database";
import { setOrgPlaneForTests, TEST_PLANE } from "../../src/auth/org-plane/config";
import { adminMiddleware } from "../../src/auth/admin-middleware";
import { isUserAdmin } from "../../src/models/admin-users";
import { requireFleetGrantReach } from "../../src/services/grant-reach";
import { adminRouter } from "../../src/routes/admin";
import { meRoutes } from "../../src/routes/me";

const hex20 = () => crypto.randomUUID().replace(/-/g, "").slice(0, 20);
const OP = `prn_${hex20()}`;
const NOBODY = `prn_${hex20()}`;
const LEGACY_ADMIN = `org-plane-admin-legacy-${hex20()}`;
let restore = () => {};
beforeAll(async () => {
  await ensurePgMigrations();
  await db.insert(hubOperators).values({ principalId: OP });
  await createTestUser({ id: LEGACY_ADMIN, role: "admin", email: `${LEGACY_ADMIN}@example.com` });
});
afterEach(() => {
  restore();
  restore = () => {};
});
afterAll(async () => {
  await db.delete(hubOperators).where(inArray(hubOperators.principalId, [OP, LEGACY_ADMIN]));
  await db.delete(user).where(eq(user.id, LEGACY_ADMIN));
});

/** adminRouter applies authMiddleware itself; stub the caller the way the plane branch would. */
const asCaller = (id: string, email?: string) =>
  new Hono()
    .use("*", async (c, next) => {
      c.set("user", { id, authType: "org_plane", tenantId: "fleet_00000000000000000000", ...(email ? { email } : {}) });
      await next();
    })
    .route("/api/admin", adminRouter)
    .route("/api", meRoutes);

describe("operator seat under the plane", () => {
  test("isUserAdmin reads hub_operators", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    expect(await isUserAdmin(OP)).toBe(true);
    expect(await isUserAdmin(NOBODY)).toBe(false);
    // A legacy admin's Better Auth role is not an operator seat under the plane.
    expect(await isUserAdmin(LEGACY_ADMIN)).toBe(false);
  });

  test("legacy isUserAdmin ignores hub_operators", async () => {
    expect(await isUserAdmin(OP)).toBe(false);
    expect(await isUserAdmin(LEGACY_ADMIN)).toBe(true);
  });

  test("legacy isUserAdmin is user.role even for a user who also holds a seat", async () => {
    await db.insert(hubOperators).values({ principalId: LEGACY_ADMIN }).onConflictDoNothing();
    await db.update(user).set({ role: "user" }).where(eq(user.id, LEGACY_ADMIN));
    try {
      expect(await isUserAdmin(LEGACY_ADMIN)).toBe(false);
    } finally {
      await db.update(user).set({ role: "admin" }).where(eq(user.id, LEGACY_ADMIN));
      await db.delete(hubOperators).where(eq(hubOperators.principalId, LEGACY_ADMIN));
    }
  });

  test("adminMiddleware admits an operator and refuses everyone else under the plane", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const guarded = (id: string) =>
      new Hono()
        .use("*", async (c, next) => {
          c.set("user", { id, authType: "org_plane", tenantId: "fleet_00000000000000000000" });
          await next();
        })
        .use("*", adminMiddleware)
        .get("/x", (c) => c.text("in"));
    expect((await guarded(OP).request("/x")).status).toBe(200);
    expect((await guarded(NOBODY).request("/x")).status).toBe(403);
  });

  test("fleet-level reach is an operator's under the plane (the principal is the caller's prn_)", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const was = process.env.ENFORCE_CONTROL_PAIR;
    process.env.ENFORCE_CONTROL_PAIR = "true";
    try {
      await expect(requireFleetGrantReach(OP)).resolves.toBeUndefined();
      await expect(requireFleetGrantReach(NOBODY)).rejects.toThrow();
    } finally {
      if (was === undefined) delete process.env.ENFORCE_CONTROL_PAIR;
      else process.env.ENFORCE_CONTROL_PAIR = was;
    }
  });

  test.each([
    ["GET", "/api/admin/users"],
    ["PUT", "/api/admin/grants/prn_aaaaaaaaaaaaaaaaaaaa"],
    ["GET", "/api/admin/grants"],
    ["POST", "/api/admin/service-principals"],
    ["POST", "/api/admin/principals/prn_aaaaaaaaaaaaaaaaaaaa/suspend"],
    ["POST", "/api/admin/settings/signup/enable"],
  ])("%s %s is 410 managed_by_org_plane for an operator", async (method, path) => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await asCaller(OP).request(path, { method, headers: { Authorization: "Bearer x", Origin: "https://console.agentpod.dev" } });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "managed_by_org_plane", url: TEST_PLANE.url });
  });
});

describe("GET /api/me", () => {
  test("under the plane: who the caller is and whether they hold an operator seat", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const body = await (await asCaller(OP).request("/api/me")).json();
    expect(body).toEqual({ id: OP, email: null, isAdmin: true, issuer: "org-plane" });
  });

  test("under the plane: the token's email claim when it has one; a non-operator is not admin", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const body = await (await asCaller(NOBODY, "someone@example.com").request("/api/me")).json();
    expect(body).toEqual({ id: NOBODY, email: "someone@example.com", isAdmin: false, issuer: "org-plane" });
  });

  test("legacy: the session's user, admin by user.role", async () => {
    const body = await (await asCaller(LEGACY_ADMIN, `${LEGACY_ADMIN}@example.com`).request("/api/me")).json();
    expect(body).toEqual({ id: LEGACY_ADMIN, email: `${LEGACY_ADMIN}@example.com`, isAdmin: true, issuer: "hub" });
  });

  test("no caller is 401, never a guess", async () => {
    const res = await new Hono().route("/api", meRoutes).request("/api/me");
    expect(res.status).toBe(401);
  });
});
