/**
 * deploy/smoke.sh, run against a fake hub in each mode.
 *
 * After the organization-plane cutover (2026-10-07) the production hub answers every
 * /api/auth/* route with 410 issuer_moved, and CI's "hub smoke (production)" job failed on
 * every push because the script still wanted the hub's own issuer routes. Under the plane those
 * 410s are the CORRECT answer — the script must require them, not just tolerate them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "..", "deploy", "smoke.sh");
const PLANE = "https://accounts.example";
const MOVED = JSON.stringify({ error: "issuer_moved", issuer: PLANE });
const MANAGED = JSON.stringify({ error: "managed_by_org_plane", url: PLANE });
const UNAUTH = JSON.stringify({ error: "unauthorized" });

type Mode = "legacy" | "plane";
type Overrides = Record<string, { status: number; body?: string }>;

const AUTH_ROUTES = ["GET /api/auth/jwks", "POST /api/auth/devices/token", "GET /api/auth/devices", "POST /api/auth/devices", "POST /api/auth/token/exchange"];

function fakeHub(mode: Mode, overrides: Overrides = {}) {
  return Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const o = overrides[key];
      if (o) return new Response(o.body ?? "", { status: o.status });
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/public/org-plane") {
        return Response.json(mode === "plane" ? { issuer: PLANE, url: PLANE, audience: "https://hub.example" } : { issuer: null });
      }
      if (url.pathname.startsWith("/api/auth/")) {
        if (mode === "plane") {
          // The real hub (auth/org-plane/retired.ts): the device inventory is a record the plane owns.
          const managed = url.pathname === "/api/auth/devices";
          return new Response(managed ? MANAGED : MOVED, { status: 410 });
        }
        if (key === "GET /api/auth/jwks") return Response.json({ keys: [] });
        if (key === "POST /api/auth/token/exchange") return new Response("", { status: 400 });
        return new Response("", { status: 401 });
      }
      if (url.pathname.startsWith("/api/evidence/")) return new Response(UNAUTH, { status: 401 });
      if (url.pathname.startsWith("/api/")) return new Response("", { status: 401 });
      return new Response("", { status: 404 });
    },
  });
}

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

async function smoke(mode: Mode, overrides: Overrides = {}) {
  server = fakeHub(mode, overrides);
  const p = Bun.spawn(["sh", SCRIPT, `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  return { code: await p.exited, out };
}

describe("deploy/smoke.sh", () => {
  test("a legacy hub (no plane) passes as before", async () => {
    const r = await smoke("legacy");
    expect(r.out).toContain("smoke passed");
    expect(r.code).toBe(0);
  });

  test("a hub under the organization plane passes when its issuer routes answer 410 issuer_moved", async () => {
    const r = await smoke("plane");
    expect(r.out).toContain("smoke passed");
    expect(r.code).toBe(0);
  });

  for (const route of AUTH_ROUTES) {
    test(`under the plane, ${route} still serving (not 410) fails the smoke`, async () => {
      const r = await smoke("plane", { [route]: { status: 200, body: "{}" } });
      expect(r.code).toBe(1);
    });
  }

  test("under the plane, a 410 that does not say issuer_moved fails (some other gone route)", async () => {
    const r = await smoke("plane", { "GET /api/auth/jwks": { status: 410, body: "{}" } });
    expect(r.code).toBe(1);
  });

  test("under the plane, the device inventory answering issuer_moved (wrong reason) fails", async () => {
    const r = await smoke("plane", { "GET /api/auth/devices": { status: 410, body: MOVED } });
    expect(r.code).toBe(1);
  });

  test("a legacy hub whose JWKS is gone still fails", async () => {
    const r = await smoke("legacy", { "GET /api/auth/jwks": { status: 410, body: MOVED } });
    expect(r.code).toBe(1);
  });
});
