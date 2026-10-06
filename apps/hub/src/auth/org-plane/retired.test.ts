process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { retiredIssuerRoutes, retiredUnderPlane } from "./retired";
import { setOrgPlaneForTests, TEST_PLANE } from "./config";
import { adminRouter } from "../../routes/admin";

const app = (plane: typeof TEST_PLANE) =>
  new Hono()
    .use("/api/auth/*", retiredIssuerRoutes(() => plane))
    .all("/api/auth/*", (c) => c.text("not retired"));

describe("retiredIssuerRoutes", () => {
  test.each([
    ["GET", "/api/auth/jwks"],
    ["GET", "/api/auth/authorize?client=apn"],
    ["POST", "/api/auth/token/exchange"],
    ["POST", "/api/auth/devices/token"],
    ["POST", "/api/auth/service-token"],
    ["POST", "/api/auth/sign-in/email"],
    ["POST", "/api/auth/sign-up/email"],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/auth/token"],
    ["GET", "/api/auth/signup-status"],
  ])("%s %s is 410 issuer_moved under the plane", async (method, path) => {
    const res = await app(TEST_PLANE).request(path, { method });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "issuer_moved", issuer: TEST_PLANE.issuer });
  });

  // The device inventory is not an issuer route: it moved to the plane's pages. `fleet devices`
  // and the console's devices page read `url` from this body to say where.
  test.each([
    ["GET", "/api/auth/devices"],
    ["POST", "/api/auth/devices"],
    ["DELETE", "/api/auth/devices/dev_0123456789abcdef0123"],
  ])("%s %s is 410 managed_by_org_plane under the plane", async (method, path) => {
    const res = await app(TEST_PLANE).request(path, { method });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "managed_by_org_plane", url: TEST_PLANE.url });
  });

  // P3 plan Task 17: the hub's issuer routes were deleted; the 410 is all that is left of them.
  test("index.ts mounts it, and nothing else under /api/auth", () => {
    const src = readFileSync(join(import.meta.dir, "..", "..", "index.ts"), "utf8");
    expect(src).toContain(".use('/api/auth/*', retiredIssuerRoutes())");
    expect(src.match(/'\/api\/auth/g)).toHaveLength(1);
    for (const gone of ["signupCheckMiddleware", "authorizeRoutes", "deviceRoutes", "serviceTokenRoutes", "auth.handler"]) {
      expect(src, gone).not.toContain(gone);
    }
  });
});

describe("retiredUnderPlane (admin routes the plane owns, decision D3)", () => {
  const mw = (plane: typeof TEST_PLANE) =>
    new Hono().use("/api/admin/*", retiredUnderPlane(() => plane)).all("/api/admin/*", (c) => c.text("hub"));

  test.each([
    ["GET", "/api/admin/users"],
    ["POST", "/api/admin/users"],
    ["GET", "/api/admin/users/u1"],
    ["POST", "/api/admin/users/u1/ban"],
    ["PUT", "/api/admin/users/u1/role"],
    ["GET", "/api/admin/settings/signup"],
    ["POST", "/api/admin/settings/signup/enable"],
    ["GET", "/api/admin/grants"],
    ["PUT", "/api/admin/grants/prn_aaaaaaaaaaaaaaaaaaaa"],
    ["DELETE", "/api/admin/grants/prn_aaaaaaaaaaaaaaaaaaaa"],
    ["GET", "/api/admin/service-principals"],
    ["POST", "/api/admin/service-principals"],
    ["POST", "/api/admin/principals/prn_aaaaaaaaaaaaaaaaaaaa/suspend"],
    ["POST", "/api/admin/principals/prn_aaaaaaaaaaaaaaaaaaaa/restore"],
  ])("%s %s is 410 managed_by_org_plane", async (method, path) => {
    const res = await mw(TEST_PLANE).request(path, { method });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "managed_by_org_plane", url: TEST_PLANE.url });
  });

  test.each([
    ["GET", "/api/admin/principals"],
    ["GET", "/api/admin/principals/prn_aaaaaaaaaaaaaaaaaaaa"],
    ["GET", "/api/admin/settings"],
    ["GET", "/api/admin/settings/speech"],
    ["GET", "/api/admin/usersettings"],
    ["GET", "/api/admin/audit-log"],
    ["GET", "/api/admin/stats"],
    ["POST", "/api/admin/agents"],
  ])("%s %s stays with the hub under the plane", async (method, path) => {
    const res = await mw(TEST_PLANE).request(path, { method });
    expect(await res.text()).toBe("hub");
  });
});

describe("adminRouter answers 410 before it authenticates", () => {
  const admin = new Hono().route("/api/admin", adminRouter);
  let restore = () => {};
  afterEach(() => restore());

  test("a retired route says where it moved, ahead of authMiddleware", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    const res = await admin.request("/api/admin/users");
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "managed_by_org_plane", url: TEST_PLANE.url });
  });

  test("a route the hub keeps still authenticates under the plane", async () => {
    restore = setOrgPlaneForTests(TEST_PLANE);
    expect((await admin.request("/api/admin/principals")).status).toBe(401);
  });

});
