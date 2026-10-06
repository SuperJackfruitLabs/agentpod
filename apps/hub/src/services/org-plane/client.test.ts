import { describe, expect, test } from "bun:test";
import { createOrgPlaneClient, OrgPlaneError, orgPlaneClient, setOrgPlaneClientForTests, type OrgPlaneClient } from "./client";
import { setOrgPlaneForTests, TEST_PLANE } from "../../auth/org-plane/config";

type Seen = { url: string; method: string; auth: string | null; body: unknown };

function fake(respond: (s: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: init.method ?? "GET",
      auth: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    seen.push(s);
    return respond(s);
  };
  return { seen, client: createOrgPlaneClient({ url: TEST_PLANE.url, credential: TEST_PLANE.serviceCredential, fetch }) };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("OrgPlaneClient", () => {
  test("agentToken posts principal and audience with the hub's svc_ credential", async () => {
    const { seen, client } = fake(() => json(200, { access_token: "tok", token_type: "Bearer", expires_in: 300 }));
    expect(await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "https://hub.test")).toEqual({ accessToken: "tok", expiresIn: 300 });
    expect(seen[0]).toEqual({
      url: "https://accounts.test/api/token/agent",
      method: "POST",
      auth: "Bearer svc_0123456789abcdef0123:s3cret",
      body: { principal: "prn_aaaaaaaaaaaaaaaaaaaa", audience: "https://hub.test" },
    });
  });

  test("agentToken sends an array audience as an array (contract §3.4)", async () => {
    const { seen, client } = fake(() => json(200, { access_token: "tok", token_type: "Bearer", expires_in: 300 }));
    await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", ["https://hub.test", "https://app.test"]);
    expect(seen[0]!.body).toEqual({ principal: "prn_aaaaaaaaaaaaaaaaaaaa", audience: ["https://hub.test", "https://app.test"] });
  });

  test.each([
    [403, "not_permitted"],
    [404, "unknown_principal"],
    [423, "suspended"],
  ])("agentToken maps %i to OrgPlaneError(%s)", async (status, code) => {
    const { client } = fake(() => json(status, { error: code }));
    const err = await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "a").catch((e) => e);
    expect(err).toBeInstanceOf(OrgPlaneError);
    expect([err.status, err.code]).toEqual([status, code]);
  });

  test("a 2xx token response without a token is an error, never an undefined token", async () => {
    const { client } = fake(() => json(200, { token_type: "Bearer" }));
    const err = await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "a").catch((e) => e);
    expect(err).toBeInstanceOf(OrgPlaneError);
    expect([err.status, err.code]).toEqual([200, "malformed_response"]);
  });

  test("an error with no JSON body still carries its status", async () => {
    const { client } = fake(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await client.listPrincipals("agent").catch((e) => e);
    expect([err.status, err.code]).toEqual([502, "error"]);
  });

  test("a network failure is OrgPlaneError(0, unreachable) and never leaks the secret", async () => {
    const client = createOrgPlaneClient({
      url: TEST_PLANE.url,
      credential: TEST_PLANE.serviceCredential,
      fetch: async () => {
        throw new Error("ECONNREFUSED Bearer svc_0123456789abcdef0123:s3cret");
      },
    });
    const err = await client.getPrincipal("prn_aaaaaaaaaaaaaaaaaaaa").catch((e) => e);
    expect([err.status, err.code]).toEqual([0, "unreachable"]);
    expect(String(err.message)).not.toContain("s3cret");
    expect(String(err.stack)).not.toContain("s3cret");
    expect(JSON.stringify(err)).not.toContain("s3cret");
  });

  test("a plane that does not answer in time is unreachable", async () => {
    const client = createOrgPlaneClient({
      url: TEST_PLANE.url,
      credential: TEST_PLANE.serviceCredential,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    });
    const err = await client.agentToken("prn_aaaaaaaaaaaaaaaaaaaa", "a").catch((e) => e);
    expect([err.status, err.code]).toEqual([0, "unreachable"]);
  });

  test("lookupIdentity percent-encodes the mxid and answers null on 404", async () => {
    const { seen, client } = fake(() => json(404, { error: "not_found" }));
    expect(await client.lookupIdentity("matrix", "@agent_x:id.agentpod.dev")).toBeNull();
    expect(seen[0]!.url).toBe("https://accounts.test/api/identities/matrix/%40agent_x%3Aid.agentpod.dev");
    expect(seen[0]!.method).toBe("GET");
  });

  test("lookupIdentity returns { principalId, kind, suspended }", async () => {
    const body = { principalId: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "human", suspended: false };
    const { client } = fake(() => json(200, body));
    expect(await client.lookupIdentity("matrix", "@op:id.test")).toEqual(body as never);
  });

  test("identitiesOf reads a principal's linked ids, filtered by system, null on 404 (contract §3.5)", async () => {
    const ids = [{ system: "matrix", externalId: "@op:id.test" }];
    const { seen, client } = fake(() => json(200, ids));
    expect(await client.identitiesOf("prn_aaaaaaaaaaaaaaaaaaaa", "matrix")).toEqual(ids);
    expect(seen[0]!.url).toBe("https://accounts.test/api/principals/prn_aaaaaaaaaaaaaaaaaaaa/identities?system=matrix");
    expect(seen[0]!.method).toBe("GET");
    expect(await fake(() => json(404, { error: "unknown_principal" })).client.identitiesOf("prn_x", "matrix")).toBeNull();
    const err = await fake(() => json(403, { error: "insufficient_scope" })).client.identitiesOf("prn_x", "matrix").catch((e) => e);
    expect([err.status, err.code]).toEqual([403, "insufficient_scope"]);
  });

  test("getPrincipal returns the principal and its grant", async () => {
    const p = {
      id: "prn_aaaaaaaaaaaaaaaaaaaa", kind: "agent", handle: "cody", displayName: "Cody", organizationId: "org_00000000000000000000",
      suspended: false, grant: { mayDispatch: [], mayGrantReach: false, scopes: ["runs:write"] },
    };
    const { seen, client } = fake(() => json(200, p));
    expect(await client.getPrincipal(p.id)).toEqual(p as never);
    expect(seen[0]!.url).toBe("https://accounts.test/api/principals/prn_aaaaaaaaaaaaaaaaaaaa");
  });

  test("getPrincipal answers null on 404 but throws on other refusals", async () => {
    expect(await fake(() => json(404, { error: "unknown_principal" })).client.getPrincipal("prn_x")).toBeNull();
    const err = await fake(() => json(403, { error: "not_permitted" })).client.getPrincipal("prn_x").catch((e) => e);
    expect([err.status, err.code]).toEqual([403, "not_permitted"]);
  });

  test("assertionToken sends the Matrix identity, never a prn_ (contract §3.4b)", async () => {
    const { seen, client } = fake(() => json(200, { access_token: "a", token_type: "Bearer", expires_in: 120 }));
    expect(await client.assertionToken({ system: "matrix", externalId: "@op:id.test" }, "https://app.test")).toEqual({ accessToken: "a", expiresIn: 120 });
    expect(seen[0]!.url).toBe("https://accounts.test/api/token/assertion");
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.auth).toBe("Bearer svc_0123456789abcdef0123:s3cret");
    expect(seen[0]!.body).toEqual({ identity: { system: "matrix", externalId: "@op:id.test" }, audience: "https://app.test" });
  });

  test.each([
    [403, "not_permitted"],
    [404, "unknown_identity"],
    [409, "not_human"],
    [423, "suspended"],
  ])("assertionToken maps %i to OrgPlaneError(%s)", async (status, code) => {
    const err = await fake(() => json(status, { error: code })).client
      .assertionToken({ system: "matrix", externalId: "@op:id.test" }, "a")
      .catch((e) => e);
    expect([err.status, err.code]).toEqual([status, code]);
  });

  test("listPrincipals always names a kind", async () => {
    const { seen, client } = fake(() => json(200, []));
    expect(await client.listPrincipals("agent")).toEqual([]);
    expect(seen[0]!.url).toBe("https://accounts.test/api/principals?kind=agent");
  });

  test("createAgent, putGrant, linkIdentity, suspend, unsuspend shapes", async () => {
    const { seen, client } = fake((s) => (s.method === "POST" && s.url.endsWith("/api/principals") ? json(201, { id: "prn_bbbbbbbbbbbbbbbbbbbb" }) : json(200, {})));
    expect(await client.createAgent({ handle: "cody", displayName: "Cody" })).toEqual({ id: "prn_bbbbbbbbbbbbbbbbbbbb" });
    await client.putGrant("prn_bbbbbbbbbbbbbbbbbbbb", { mayDispatch: ["prn_cccccccccccccccccccc"], mayGrantReach: true, scopes: ["runs:write"] });
    await client.linkIdentity("prn_bbbbbbbbbbbbbbbbbbbb", "matrix", "@agent_cody:id.agentpod.dev");
    await client.suspend("prn_bbbbbbbbbbbbbbbbbbbb");
    await client.unsuspend("prn_bbbbbbbbbbbbbbbbbbbb");
    expect(seen.map((s) => `${s.method} ${s.url.replace(TEST_PLANE.url, "")}`)).toEqual([
      "POST /api/principals",
      "PUT /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/grants",
      "PUT /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/identities/matrix",
      "POST /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/suspend",
      "POST /api/principals/prn_bbbbbbbbbbbbbbbbbbbb/unsuspend",
    ]);
    expect(seen[0]!.body).toEqual({ kind: "agent", handle: "cody", displayName: "Cody" });
    expect(seen[1]!.body).toEqual({ mayDispatch: ["prn_cccccccccccccccccccc"], mayGrantReach: true, scopes: ["runs:write"] });
    expect(seen[2]!.body).toEqual({ externalId: "@agent_cody:id.agentpod.dev" });
    expect(seen.every((s) => s.auth === "Bearer svc_0123456789abcdef0123:s3cret")).toBe(true);
  });

  test("createAgent without an id in the answer is an error", async () => {
    const err = await fake(() => json(201, {})).client.createAgent({ handle: "h", displayName: "H" }).catch((e) => e);
    expect([err.status, err.code]).toEqual([201, "malformed_response"]);
  });
});

describe("orgPlaneClient()", () => {
  test("refuses in legacy mode", () => {
    const restore = setOrgPlaneForTests(null);
    try {
      expect(() => orgPlaneClient()).toThrow(/ORG_PLANE_\* unset/);
    } finally {
      restore();
    }
  });

  test("a test override wins", () => {
    const stub = {} as OrgPlaneClient;
    const restore = setOrgPlaneClientForTests(stub);
    try {
      expect(orgPlaneClient()).toBe(stub);
    } finally {
      restore();
    }
  });

  test("builds one client from the configured plane", () => {
    const restore = setOrgPlaneForTests(TEST_PLANE);
    try {
      expect(orgPlaneClient()).toBe(orgPlaneClient());
    } finally {
      restore();
    }
  });
});
