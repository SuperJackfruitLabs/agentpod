import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createOrgPlaneDiscoveryRoutes } from "./org-plane-discovery";
import { TEST_PLANE } from "../auth/org-plane/config";

describe("GET /public/org-plane", () => {
  test("names the plane's issuer, url and audience — never the credential", async () => {
    const app = new Hono().route("/public", createOrgPlaneDiscoveryRoutes(() => TEST_PLANE));
    const res = await app.request("/public/org-plane");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ issuer: TEST_PLANE.issuer, url: TEST_PLANE.url, audience: TEST_PLANE.audience });
    expect(JSON.stringify(body)).not.toContain(TEST_PLANE.serviceCredential.secret);
  });
});
