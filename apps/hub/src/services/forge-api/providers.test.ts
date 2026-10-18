import { describe, expect, test } from "bun:test";

import type { ForgeApiMode, ForgeApiPreset, ForgeApiProvider } from "@agentpod/contract";

import type { FetchLike } from "../forge";
import { ForgeApiConfigError } from "./errors";
import { tokenName } from "./forgejo";
import { getProvider, splitRepo, type ForgeGrantRef } from "./providers";

const cfg = { baseUrl: "https://forge.test", adminToken: "c0ffee".repeat(6) + "abcd" };
const SECRET = "5ec0de".repeat(6) + "beef";

function grant(over: Partial<ForgeGrantRef> = {}): ForgeGrantRef {
  return {
    id: "g1",
    provider: "forgejo" as ForgeApiProvider,
    instance: "https://forge.test",
    mode: "minted" as ForgeApiMode,
    account: "coder-kai",
    expectedLogin: null,
    preset: "read" as ForgeApiPreset,
    repositories: ["Org/repo"],
    generation: 1,
    ...over,
  };
}

function scripted(responses: Array<[number, unknown]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const [status, body] = responses.shift() ?? [500, {}];
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe("forgejo provider", () => {
  const p = (fetchImpl?: FetchLike) => getProvider("forgejo", { cfg, fetchImpl });

  test("modes", () => expect(p().modes).toEqual(["minted", "supplied"]));

  test("mint sends scopes and repositories as {owner,name} objects and returns the sha1 as secret", async () => {
    const { fetchImpl, calls } = scripted([[201, { id: 9, name: "agentpod-g1-g1", sha1: SECRET }]]);
    const out = await p(fetchImpl).mint!("coder-kai", {
      name: "agentpod-g1-g1",
      scopes: ["read:repository"],
      repositories: [{ owner: "Org", name: "repo" }],
    });
    expect(out).toEqual({ id: 9, name: "agentpod-g1-g1", secret: SECRET });
    expect(calls[0]!.url).toBe("https://forge.test/api/v1/admin/users/coder-kai/tokens");
    const sent = calls[0]!.body as Record<string, unknown>;
    expect(sent.scopes).toEqual(["read:repository"]);
    expect(sent.repositories).toEqual([{ owner: "Org", name: "repo" }]);
    expect(sent.name).toBe("agentpod-g1-g1");
  });

  test("mint without repositories throws before any request", async () => {
    const { fetchImpl, calls } = scripted([[201, { id: 1, name: "n", sha1: SECRET }]]);
    await expect(
      p().mint!("coder-kai", { name: "n", scopes: ["read:repository"], repositories: [] }),
    ).rejects.toThrow(/repositor/i);
    expect(calls.length).toBe(0);
  });

  test("mint error messages never include a response body or the token", async () => {
    // The stub checks the admin token really is sent, then reflects it AND the minted secret back
    // in the error body, the way a forge that echoes the request would.
    const fetchImpl: FetchLike = async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      expect(auth).toBe(`token ${cfg.adminToken}`);
      return new Response(JSON.stringify({ message: `body-marker ${auth} ${SECRET}` }), { status: 400 });
    };
    const err = await p(fetchImpl)
      .mint!("coder-kai", { name: "n", scopes: ["read:repository"], repositories: [{ owner: "o", name: "r" }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const text = String((err as Error).message) + String((err as Error).stack ?? "");
    expect(text).toContain("400");
    expect(text).not.toContain("body-marker");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(cfg.adminToken);
  });

  test("mint returns id undefined when forge sends none, never a fake 0", async () => {
    const { fetchImpl } = scripted([[201, { name: "n", sha1: SECRET }]]);
    const out = await p(fetchImpl).mint!("coder-kai", {
      name: "n",
      scopes: ["read:repository"],
      repositories: [{ owner: "o", name: "r" }],
    });
    expect(out.id).toBeUndefined();
    expect(out.name).toBe("n");
  });

  test("mintScopes gives the preset's scopes for a minted grant", () => {
    expect(p().mintScopes(grant({ preset: "issues" }))).toEqual(["read:repository", "write:issue"]);
  });

  test("mintScopes refuses a supplied grant with a typed error (supplied never mints)", () => {
    const err = (() => {
      try {
        p().mintScopes(grant({ mode: "supplied", expectedLogin: "m", preset: "none" }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForgeApiConfigError);
    expect((err as ForgeApiConfigError).code).toBe("mode-not-minted");
    expect((err as ForgeApiConfigError).status).toBe(422);
  });

  test("mintScopes refuses minted + none with a typed error", () => {
    const err = (() => {
      try {
        p().mintScopes(grant({ preset: "none" }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForgeApiConfigError);
    expect((err as ForgeApiConfigError).code).toBe("preset-none-needs-no-token");
    expect((err as ForgeApiConfigError).status).toBe(422);
  });

  test("scopesFor each preset", () => {
    const g = (preset: ForgeApiPreset) => p().scopesFor(preset);
    expect(g("read")).toEqual(["read:repository"]);
    expect(g("issues")).toEqual(["read:repository", "write:issue"]);
    expect(g("pull-requests")).toEqual(["read:repository", "write:issue", "write:repository"]);
    expect(g("maintain")).toEqual(["write:repository", "write:issue"]);
  });

  test("none is refused for minted mode", () => {
    expect(() => p().scopesFor("none")).toThrow(/none/);
  });

  test("revoke deletes by name and treats 404 as success", async () => {
    const a = scripted([[404, { message: "no" }]]);
    await p(a.fetchImpl).revoke!("coder-kai", { name: "tok" });
    expect(a.calls[0]!.method).toBe("DELETE");
    expect(a.calls[0]!.url).toBe("https://forge.test/api/v1/admin/users/coder-kai/tokens/tok");
    const b = scripted([[500, { message: SECRET }]]);
    const err = await p(b.fetchImpl).revoke!("coder-kai", { name: "tok" }).catch((e) => e);
    expect(String(err)).toContain("500");
    expect(String(err)).not.toContain(SECRET);
  });

  test("listTokens pages GET /admin/users/{u}/tokens and keeps only id and name", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `agentpod-x-g${i}`, token_last_eight: "abcd1234", sha1: SECRET }));
    // A short page is not the end (a forge may cap page size below the limit asked); an empty one is.
    const a = scripted([
      [200, page1],
      [200, [{ id: 99, name: "laptop", token_last_eight: "zzzz9999" }]],
      [200, []],
    ]);
    const out = await p(a.fetchImpl).listTokens!("coder-kai");
    expect(a.calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://forge.test/api/v1/admin/users/coder-kai/tokens?page=1&limit=50"],
      ["GET", "https://forge.test/api/v1/admin/users/coder-kai/tokens?page=2&limit=50"],
      ["GET", "https://forge.test/api/v1/admin/users/coder-kai/tokens?page=3&limit=50"],
    ]);
    expect(out.length).toBe(51);
    expect(out[50]).toEqual({ id: 99, name: "laptop" });
    expect(JSON.stringify(out)).not.toContain(SECRET);
    const b = scripted([[403, { message: SECRET }]]);
    const err = await p(b.fetchImpl).listTokens!("coder-kai").catch((e) => e);
    expect(String(err)).toContain("403");
    expect(String(err)).not.toContain(SECRET);
  });

  test("token name is unique per generation", () => {
    expect(tokenName(grant({ generation: 1 }))).toBe("agentpod-g1-g1");
    expect(tokenName(grant({ generation: 2 }))).toBe("agentpod-g1-g2");
    expect(tokenName(grant({ generation: 1 }))).not.toBe(tokenName(grant({ generation: 2 })));
  });

  test("expectedIdentity: account for minted, declared login for supplied", () => {
    expect(p().expectedIdentity(grant())).toBe("coder-kai");
    expect(p().expectedIdentity(grant({ mode: "supplied", expectedLogin: "machine" }))).toBe("machine");
    expect(() => p().expectedIdentity(grant({ mode: "supplied", expectedLogin: null }))).toThrow(/login/i);
  });
});

describe("github provider", () => {
  const p = () => getProvider("github");

  test("github has no mint or revoke; modes app and supplied", () => {
    expect(p().mint).toBeUndefined();
    expect(p().revoke).toBeUndefined();
    expect(p().modes).toEqual(["app", "supplied"]);
  });

  test("expectedIdentity: slug[bot] for app, declared login for supplied", () => {
    expect(p().expectedIdentity(grant({ provider: "github", mode: "app", expectedLogin: "my-app" }))).toBe("my-app[bot]");
    expect(() => p().expectedIdentity(grant({ provider: "github", mode: "app", expectedLogin: null }))).toThrow();
    expect(() => p().expectedIdentity(grant({ provider: "github", mode: "app", expectedLogin: "my-app[bot]" }))).toThrow(/bot/);
    expect(p().expectedIdentity(grant({ provider: "github", mode: "supplied", expectedLogin: "octo" }))).toBe("octo");
    expect(() => p().expectedIdentity(grant({ provider: "github", mode: "supplied", expectedLogin: null }))).toThrow();
  });

  test("mintScopes is a typed refusal: github never mints", () => {
    expect(() => p().mintScopes(grant({ provider: "github", mode: "app", expectedLogin: "a" }))).toThrow(
      ForgeApiConfigError,
    );
  });

  test("scopesFor returns []", () => {
    expect(p().scopesFor("maintain")).toEqual([]);
  });
});

describe("getProvider", () => {
  test("gitea and bitbucket are specified but not built", () => {
    expect(() => getProvider("gitea")).toThrow(/provider not supported yet/);
    expect(() => getProvider("bitbucket")).toThrow(/provider not supported yet/);
  });
});

describe("splitRepo", () => {
  test("splits owner/name", () => expect(splitRepo("Org/repo")).toEqual({ owner: "Org", name: "repo" }));
  for (const bad of ["", "repo", "a/b/c", "/b", "a/", "/"]) {
    test(`rejects ${JSON.stringify(bad)}`, () => expect(() => splitRepo(bad)).toThrow());
  }
});

describe("checkToken (hub-side validity check before sealing)", () => {
  test("forgejo: GET /api/v1/user with the token, returns the login", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, auth: String((init?.headers as Record<string, string>).Authorization) });
      return new Response(JSON.stringify({ login: "coder-kai", id: 3 }), { status: 200 });
    };
    const out = await getProvider("forgejo", { cfg, fetchImpl }).checkToken!("coder-kai", SECRET);
    expect(out).toEqual({ login: "coder-kai" });
    expect(seen).toEqual([{ url: "https://forge.test/api/v1/user", auth: `token ${SECRET}` }]);
  });

  test("forgejo: a 401 whose body reflects the Authorization header never leaks the token", async () => {
    const fetchImpl: FetchLike = async (_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ message: `body-marker ${auth}` }), { status: 401 });
    };
    const err = await getProvider("forgejo", { cfg, fetchImpl }).checkToken!("coder-kai", SECRET).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const text = String(err.message) + String(err.stack ?? "");
    expect(text).toContain("401");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("body-marker");
  });

  test("forgejo: a network error carrying the token is scrubbed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect failed token ${SECRET}`);
    };
    const err = await getProvider("forgejo", { cfg, fetchImpl }).checkToken!("coder-kai", SECRET).catch((e) => e);
    expect(String(err.message) + String(err.stack ?? "")).not.toContain(SECRET);
  });

  test("github: not applicable", async () => {
    const err = await getProvider("github").checkToken!("x", SECRET).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toMatch(/not applicable/);
    expect(String(err.message)).not.toContain(SECRET);
  });
});
