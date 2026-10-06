import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createOrgPlaneDiscoveryRoutes } from "./org-plane-discovery";
import { TEST_PLANE } from "../auth/org-plane/config";

describe("GET /public/org-plane", () => {
  test("legacy mode says there is no issuer", async () => {
    const app = new Hono().route("/public", createOrgPlaneDiscoveryRoutes(() => null));
    const res = await app.request("/public/org-plane");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: null });
  });

  test("plane mode names issuer, url and audience — never the credential", async () => {
    const app = new Hono().route("/public", createOrgPlaneDiscoveryRoutes(() => TEST_PLANE));
    const body = await (await app.request("/public/org-plane")).json();
    expect(body).toEqual({ issuer: TEST_PLANE.issuer, url: TEST_PLANE.url, audience: TEST_PLANE.audience });
    expect(JSON.stringify(body)).not.toContain(TEST_PLANE.serviceCredential.secret);
  });
});
