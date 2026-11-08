import { describe, expect, test } from "bun:test";

import { RELAY_CREDENTIAL_ENV, createSuperpipelineRelay, readRelayCredential, type RelayDeps } from "./relay";

/**
 * The SuperPipeline decision relay (charter: waiting cards and broker approvals reach chat §3–4):
 * an optional Accounts service credential holding `approval-requests:relay`. It belongs to one
 * workspace — the `org` claim of the token the plane mints for it — and its token is handed out for
 * that workspace's boards only.
 */

/** An unsigned token whose payload is `claims`: the relay reads the `org` claim, it never verifies. */
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function token(claims: Record<string, unknown>): string {
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}

const ORG = "org_0123456789abcdef0123";
const TENANT = "fleet_relay";

function relay(over: Partial<RelayDeps> = {}) {
  let exchanges = 0;
  let now = 1_000_000;
  const deps: RelayDeps = {
    exchange: async () => {
      exchanges++;
      return { accessToken: token({ org: ORG, n: exchanges }), expiresIn: 300 };
    },
    tenantForOrg: async (org) => (org === ORG ? TENANT : null),
    now: () => now,
    ...over,
  };
  return {
    relay: createSuperpipelineRelay(deps),
    exchanges: () => exchanges,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("the relay credential in the environment", () => {
  test("unset is no relay; a readable svc line is the credential", () => {
    expect(readRelayCredential({})).toEqual({ ok: true, credential: null });
    expect(readRelayCredential({ [RELAY_CREDENTIAL_ENV]: "  " })).toEqual({ ok: true, credential: null });
    expect(readRelayCredential({ [RELAY_CREDENTIAL_ENV]: "/run/relay" }, () => "svc_0123456789abcdef0123:s3cret\n")).toEqual({
      ok: true,
      credential: { id: "svc_0123456789abcdef0123", secret: "s3cret" },
    });
  });

  test("set and unreadable, or not a svc line, is an error that never quotes the file", () => {
    const unreadable = readRelayCredential({ [RELAY_CREDENTIAL_ENV]: "/nope" }, () => {
      throw new Error("ENOENT");
    });
    expect(unreadable).toEqual({ ok: false, message: "cannot be read" });
    const malformed = readRelayCredential({ [RELAY_CREDENTIAL_ENV]: "/run/relay" }, () => "spa_agent_token_secret");
    expect(malformed.ok).toBe(false);
    expect(JSON.stringify(malformed)).not.toContain("spa_agent_token_secret");
  });
});

describe("the tenant rule: one workspace's credential, that workspace's boards only", () => {
  test("its token for its own tenant, and null for any other", async () => {
    const { relay: r } = relay();
    expect(await r.tokenFor(TENANT)).toBe(token({ org: ORG, n: 1 }));
    expect(await r.tokenFor("fleet_other")).toBeNull();
  });

  test("a workspace with no tenant here, or a token with no workspace, relays nothing", async () => {
    expect(await relay({ tenantForOrg: async () => null }).relay.tokenFor(TENANT)).toBeNull();
    const noOrg = relay({ exchange: async () => ({ accessToken: token({ sub: "svc_x" }), expiresIn: 300 }) });
    expect(await noOrg.relay.tokenFor(TENANT)).toBeNull();
  });

  test("an exchange the plane refuses is null, never a throw, and is tried again next time", async () => {
    let fail = true;
    const { relay: r } = relay({
      exchange: async () => {
        if (fail) throw new Error("org plane answered 401 (invalid_client)");
        return { accessToken: token({ org: ORG }), expiresIn: 300 };
      },
    });
    expect(await r.tokenFor(TENANT)).toBeNull();
    fail = false;
    expect(await r.tokenFor(TENANT)).toBe(token({ org: ORG }));
  });

  test("the token is reused until a minute before it expires, then renewed", async () => {
    const t = relay();
    await t.relay.tokenFor(TENANT);
    t.advance(239_000);
    await t.relay.tokenFor(TENANT);
    expect(t.exchanges()).toBe(1);
    t.advance(2_000);
    expect(await t.relay.tokenFor(TENANT)).toBe(token({ org: ORG, n: 2 }));
    expect(t.exchanges()).toBe(2);
  });
});
