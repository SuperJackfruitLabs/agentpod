import { describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { createPlaneVerifier } from "./verify";

const ISS = "https://accounts.test";
const AUD = "https://hub.test";
const JWKS = "https://accounts.test/api/auth/jwks";

async function keypair(kid: string, alg: "EdDSA" | "ES256" = "EdDSA") {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" } as JWK;
  return { pub, privateKey, kid, alg };
}

type Key = Awaited<ReturnType<typeof keypair>>;

function sign(key: Key, claims: Record<string, unknown> = {}, nowSec = Math.floor(Date.now() / 1000)) {
  return new SignJWT({
    principalKind: "human",
    org: "org_00000000000000000000",
    ent: ["agentpod"],
    mayDispatch: [],
    mayGrantReach: false,
    jti: crypto.randomUUID(),
    ...claims,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer((claims.iss as string) ?? ISS)
    .setSubject("prn_0123456789abcdef0123")
    .setAudience((claims.aud as string | string[]) ?? AUD)
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 300)
    .sign(key.privateKey);
}

/** A JWKS endpoint whose keys and liveness the test controls, counting fetches. */
function plane(keys: JWK[]) {
  const state = { keys, down: false, fetches: 0 };
  const fetch = async (url: string) => {
    state.fetches++;
    if (url !== JWKS) throw new Error(`unexpected ${url}`);
    if (state.down) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ keys: state.keys }), { headers: { "content-type": "application/json" } });
  };
  return { state, fetch };
}

describe("createPlaneVerifier", () => {
  test("accepts a token for this audience and returns its claims", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    const claims = await v.verify(await sign(k));
    expect(claims?.sub).toBe("prn_0123456789abcdef0123");
    expect(claims?.org).toBe("org_00000000000000000000");
  });

  test("an aud array containing the hub is accepted; one without it is refused", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    expect(await v.verify(await sign(k, { aud: ["https://other.test", AUD] }))).not.toBeNull();
    expect(await v.verify(await sign(k, { aud: ["https://other.test"] }))).toBeNull();
  });

  test("the issuer is compared exactly — a trailing slash is a different issuer", async () => {
    const k = await keypair("k1");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([k.pub]).fetch });
    expect(await v.verify(await sign(k, { iss: `${ISS}/` }))).toBeNull();
  });

  test("EdDSA only: an ES256 token is refused even when its key is published", async () => {
    const es = await keypair("es", "ES256");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([es.pub]).fetch });
    expect(await v.verify(await sign(es))).toBeNull();
  });

  test("a v7-shaped token (tenant, no org) is refused", async () => {
    const k = await keypair("k1");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([k.pub]).fetch });
    expect(await v.verify(await sign(k, { org: undefined, tenant: "fleet_00000000000000000000" }))).toBeNull();
  });

  test("caches the key set, and refetches once it is ten minutes old", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now });
    const nowSec = () => Math.floor(now / 1000);
    await v.verify(await sign(k, {}, nowSec()));
    await v.verify(await sign(k, {}, nowSec()));
    expect(p.state.fetches).toBe(1);
    now += 10 * 60 * 1000;
    await v.verify(await sign(k, {}, nowSec()));
    expect(p.state.fetches).toBe(2);
  });

  test("an unknown kid triggers a refetch, so a rotated key verifies at once", async () => {
    const k1 = await keypair("k1");
    const k2 = await keypair("k2");
    const p = plane([k1.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch });
    await v.verify(await sign(k1));
    p.state.keys = [k1.pub, k2.pub];
    expect(await v.verify(await sign(k2))).not.toBeNull();
    expect(p.state.fetches).toBe(2);
  });

  test("serves the last good key set when the plane is down (design §9 Offline)", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now });
    await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    p.state.down = true;
    now += 60 * 60 * 1000; // an hour later: the cache is stale and the plane is unreachable
    expect(await v.verify(await sign(k, {}, Math.floor(now / 1000)))).not.toBeNull();
  });

  test("a down plane is not hammered: one retry per retryAfterMs", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now, retryAfterMs: 30_000 });
    await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    p.state.down = true;
    now += 11 * 60 * 1000;
    for (let i = 0; i < 5; i++) await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    expect(p.state.fetches).toBe(2);
  });

  test("a token signed by an unpublished key is refused, and unknown kids cannot force a refetch storm", async () => {
    const k = await keypair("k1");
    const rogue = await keypair("rogue");
    const p = plane([k.pub]);
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, retryAfterMs: 30_000 });
    await v.verify(await sign(k));
    for (let i = 0; i < 5; i++) expect(await v.verify(await sign(rogue))).toBeNull();
    expect(p.state.fetches).toBe(2);
  });
  test("a burst of distinct unknown kids triggers at most one refetch per kidRefetchMs", async () => {
    const k = await keypair("k1");
    const p = plane([k.pub]);
    let now = 1_900_000_000_000;
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: p.fetch, now: () => now, kidRefetchMs: 5_000 });
    await v.verify(await sign(k, {}, Math.floor(now / 1000)));
    for (let i = 0; i < 5; i++) {
      const rogue = await keypair(`rogue-${i}`);
      expect(await v.verify(await sign(rogue, {}, Math.floor(now / 1000)))).toBeNull();
    }
    expect(p.state.fetches).toBe(2);
    now += 5_000;
    const rotated = await keypair("k2");
    p.state.keys = [k.pub, rotated.pub];
    expect(await v.verify(await sign(rotated, {}, Math.floor(now / 1000)))).not.toBeNull();
    expect(p.state.fetches).toBe(3);
  });

  test("client_id and azp are ignored and amr is not required", async () => {
    const k = await keypair("k1");
    const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: JWKS, fetch: plane([k.pub]).fetch });
    const claims = await v.verify(await sign(k, { client_id: "superpipeline-web", azp: "superpipeline-web", sid: "s" }));
    expect(claims?.sub).toBe("prn_0123456789abcdef0123");
    expect(claims?.amr).toBeUndefined();
  });
  describe("a plane that accepts the connection and never answers (review finding 2)", () => {
    /** A real HTTP server that serves the key set until `stall` is set, then never responds. */
    function stallingPlane(keys: JWK[]) {
      const state = { stall: false, requests: 0 };
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch() {
          state.requests++;
          if (state.stall) return new Promise<Response>(() => {});
          return Response.json({ keys });
        },
      });
      return { state, url: `http://127.0.0.1:${server.port}/api/auth/jwks`, stop: () => server.stop(true) };
    }

    test("a stale cached set verifies at once while the refresh hangs", async () => {
      const k = await keypair("k1");
      const p = stallingPlane([k.pub]);
      try {
        let now = Date.now();
        const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: p.url, now: () => now, fetchTimeoutMs: 3_000 });
        expect(await v.verify(await sign(k, {}, Math.floor(now / 1000)))).not.toBeNull();
        p.state.stall = true;
        now += 11 * 60 * 1000; // stale
        const started = performance.now();
        expect(await v.verify(await sign(k, {}, Math.floor(now / 1000)))).not.toBeNull();
        expect(performance.now() - started).toBeLessThan(500);
        expect(p.state.requests).toBe(2); // the refresh was attempted, just not awaited
      } finally {
        p.stop();
      }
    });

    test("an unknown kid's refetch against a hung plane is bounded by the timeout and falls back to the cached set", async () => {
      const k = await keypair("k1");
      const rogue = await keypair("rogue");
      const p = stallingPlane([k.pub]);
      try {
        const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: p.url, fetchTimeoutMs: 200 });
        expect(await v.verify(await sign(k))).not.toBeNull();
        p.state.stall = true;
        const started = performance.now();
        expect(await v.verify(await sign(rogue))).toBeNull();
        const took = performance.now() - started;
        expect(took).toBeGreaterThanOrEqual(150);
        expect(took).toBeLessThan(1_500);
        // and the known key still verifies against the cached set afterwards
        expect(await v.verify(await sign(k))).not.toBeNull();
      } finally {
        p.stop();
      }
    });

    test("with no cached set, a hung plane fails the request within the timeout instead of stalling it", async () => {
      const k = await keypair("k1");
      const p = stallingPlane([k.pub]);
      p.state.stall = true;
      try {
        const v = createPlaneVerifier({ issuer: ISS, audience: AUD, jwksUrl: p.url, fetchTimeoutMs: 200 });
        const started = performance.now();
        expect(await v.verify(await sign(k))).toBeNull();
        expect(performance.now() - started).toBeLessThan(1_500);
      } finally {
        p.stop();
      }
    });
  });
});
