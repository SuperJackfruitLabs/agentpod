import { describe, expect, test } from "bun:test";

import { agentEmail, ensureAgentUser, mintAgentToken, revokeAgentToken, type ForgeConfig } from "./forge";

/**
 * Provisioning an agent's git identity on forge.
 *
 * Every quirk asserted here was met while doing this by hand against the live instance
 * (Forgejo 16.0.5) and would otherwise be rediscovered by whoever onboards the next agent.
 */
const cfg: ForgeConfig = { baseUrl: "https://forge.test", adminToken: "tok" };

/** A fetch that answers a scripted queue and records what it was asked. */
function scripted(responses: Array<[number, unknown]>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const [status, body] = responses.shift() ?? [500, {}];
    calls.push({
      method: init?.method ?? "GET",
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), { status });
  };
  /** The nth call, or a failure that says which one was missing rather than a TypeError. */
  const at = (i: number) => {
    const c = calls[i];
    if (!c) throw new Error(`expected at least ${i + 1} call(s), saw ${calls.length}`);
    return c;
  };
  return { fetchImpl, calls, at };
}

describe("agentEmail", () => {
  test("puts an agent in the identity domain it already lives in", () => {
    // Agents are `@agent_…:id.agentpod.dev` in Matrix. A second invented domain would split one
    // principal across two namespaces.
    expect(agentEmail("coder-kai")).toBe("coder-kai@id.agentpod.dev");
  });
});

describe("ensureAgentUser", () => {
  test("creates an account that does not exist, with a password it never returns", async () => {
    const { fetchImpl, at } = scripted([
      [404, { message: "user does not exist" }],
      [201, { id: 3, login: "coder-kai", email: "coder-kai@id.agentpod.dev" }],
    ]);

    const result = await ensureAgentUser(cfg, "coder-kai", fetchImpl);

    expect(result.created).toBe(true);
    expect(result.user.login).toBe("coder-kai");
    expect(at(1).method).toBe("POST");
    expect(at(1).url).toBe("https://forge.test/api/v1/admin/users");

    const sent = at(1).body as Record<string, unknown>;
    // Forgejo answers `PasswordIsRequired` without one, though its own schema calls it optional.
    expect(typeof sent.password).toBe("string");
    expect((sent.password as string).length).toBeGreaterThan(20);
    // Nothing about the password is handed back: the account authenticates by token, and an admin
    // resets it if one is ever needed.
    expect(JSON.stringify(result)).not.toContain(sent.password as string);
    expect(sent.must_change_password).toBe(false);
  });

  test("is idempotent: an existing account is not created again", async () => {
    const { fetchImpl, calls, at } = scripted([[200, { id: 3, login: "coder-kai", email: "x@y" }]]);
    const result = await ensureAgentUser(cfg, "coder-kai", fetchImpl);
    expect(result.created).toBe(false);
    expect(calls).toHaveLength(1);
    expect(at(0).method).toBe("GET");
  });
});

describe("mintAgentToken", () => {
  test("reads the token from `sha1`, which is where Forgejo puts it", async () => {
    // Not `token`. A reader expecting `token` gets undefined and hands an empty credential onward.
    const { fetchImpl, at } = scripted([[201, { id: 4, name: "station-x", sha1: "a".repeat(40) }]]);

    const minted = await mintAgentToken(cfg, "coder-kai", {
      name: "station-x",
      repositories: ["SuperJackfruitLabs/super-jackfruit-website"],
    }, fetchImpl);

    expect(minted.token).toBe("a".repeat(40));
    expect(minted.name).toBe("station-x");
    expect(at(0).url).toBe("https://forge.test/api/v1/admin/users/coder-kai/tokens");
    const sent = at(0).body as Record<string, unknown>;
    expect(sent.scopes).toEqual(["write:repository"]);
    // Confined to the repositories it works on, which the API supports and nothing else enforces.
    expect(sent.repositories).toEqual(["SuperJackfruitLabs/super-jackfruit-website"]);
  });

  test("a 2xx carrying no token is a failure, not an empty credential", async () => {
    const { fetchImpl } = scripted([[201, { id: 4, name: "station-x" }]]);
    await expect(
      mintAgentToken(cfg, "coder-kai", { name: "station-x" }, fetchImpl),
    ).rejects.toThrow(/token/i);
  });

  test("a refusal names the status and not the body", async () => {
    // forge answers a bad request with `%!s(<nil>)` — a Go format string printing a nil error — so
    // the body is noise at best, and at worst it echoes what was sent.
    const { fetchImpl } = scripted([[400, { message: "%!s(<nil>)" }]]);
    const err = await mintAgentToken(cfg, "coder-kai", { name: "x" }, fetchImpl).catch((e) => e);
    expect(String(err)).toContain("400");
    expect(String(err)).not.toContain("%!s");
  });
});

describe("revokeAgentToken", () => {
  test("deletes by name, so a station's credential can be withdrawn on its own", async () => {
    const { fetchImpl, at } = scripted([[204, {}]]);
    await revokeAgentToken(cfg, "coder-kai", "station-x", fetchImpl);
    expect(at(0).method).toBe("DELETE");
    expect(at(0).url).toBe("https://forge.test/api/v1/admin/users/coder-kai/tokens/station-x");
  });
});
