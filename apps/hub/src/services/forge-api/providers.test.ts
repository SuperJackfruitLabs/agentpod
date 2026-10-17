import { describe, expect, test } from "bun:test";

import type { ForgeApiMode, ForgeApiPreset, ForgeApiProvider } from "@agentpod/contract";

import type { FetchLike } from "../forge";
import { tokenName } from "./forgejo";
import { getProvider, splitRepo, type ForgeGrantRef } from "./providers";

const cfg = { baseUrl: "https://forge.test", adminToken: "ADMIN-SECRET-TOKEN" };
const SECRET = "s3cr3t-token-" + "b".repeat(30);

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
    const { fetchImpl } = scripted([[400, { message: `echo ${SECRET} body-marker` }]]);
    const err = await p(fetchImpl)
      .mint!("coder-kai", { name: "n", scopes: ["read:repository"], repositories: [{ owner: "o", name: "r" }] })
      .catch((e) => e);
    const text = String(err) + String((err as Error).stack ?? "");
    expect(text).toContain("400");
    expect(text).not.toContain("body-marker");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(cfg.adminToken);
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
