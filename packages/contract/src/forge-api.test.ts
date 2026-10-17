import { describe, it, expect } from "bun:test";
import { VERB_PARAMS, VERB_RESULTS } from "./protocol";
import { Capability, CapabilityList, unknownCapabilitiesByStation } from "./station";
import { ForgeApiMode, ForgeApiProvider, ForgeApiPreset } from "./forge-api";

const VERBS = ["forge.api.deliver", "forge.api.policy", "forge.api.verify", "forge.api.revoke", "forge.api.status"] as const;

const deliver = {
  stationId: "stn_a",
  stationKey: "hermes:a",
  grantId: "fag_1",
  provider: "forgejo",
  instance: "https://forge.example.com",
  mode: "minted",
  serviceName: "forge-a",
  repositories: ["org/repo"],
  preset: "read",
  rules: [{ allow: "GET /repos/org/repo/**", when: { method: "GET" } }],
  allowGraphql: false,
  sealed: "stk-handover-v1:AAAA",
  expectLogin: "agent-a",
};

describe("forge.api contract", () => {
  it("forge-api verbs parse a full deliver frame", () => {
    expect(VERB_PARAMS["forge.api.deliver"].parse(deliver)).toEqual(deliver);
    expect(ForgeApiMode.options).toEqual(["minted", "app", "supplied"]);
    expect(ForgeApiProvider.options).toEqual(["forgejo", "gitea", "github", "bitbucket"]);
    expect(ForgeApiPreset.options).toEqual(["read", "issues", "pull-requests", "maintain", "none"]);
    expect(VERB_PARAMS["forge.api.policy"].parse({ stationId: "s", grantId: "g", preset: "none", rules: [], allowGraphql: true }).allowGraphql).toBe(true);
    expect(VERB_PARAMS["forge.api.verify"].parse({ stationId: "s", grantId: "g", expectLogin: "x" })).toBeTruthy();
    expect(VERB_PARAMS["forge.api.revoke"].parse({ stationId: "s", grantId: "g" })).toBeTruthy();
    expect(VERB_PARAMS["forge.api.status"].parse({ stationId: "s" })).toBeTruthy();
  });

  it("deliver rejects a frame carrying a field named token or secret or password", () => {
    for (const k of ["token", "secret", "password"]) {
      expect(VERB_PARAMS["forge.api.deliver"].safeParse({ ...deliver, [k]: "x" }).success).toBe(false);
    }
    for (const verb of VERBS) {
      const ok = {
        "forge.api.deliver": deliver,
        "forge.api.policy": { stationId: "s", grantId: "g", preset: "read", rules: [], allowGraphql: false },
        "forge.api.verify": { stationId: "s", grantId: "g", expectLogin: "x" },
        "forge.api.revoke": { stationId: "s", grantId: "g" },
        "forge.api.status": { stationId: "s" },
      }[verb];
      expect(VERB_PARAMS[verb].safeParse(ok).success).toBe(true);
      expect(VERB_PARAMS[verb].safeParse({ ...ok, token: "x" }).success).toBe(false);
    }
    // rules are strict too: a credential cannot hide inside a rule
    expect(VERB_PARAMS["forge.api.deliver"].safeParse({ ...deliver, rules: [{ allow: "x", token: "y" }] }).success).toBe(false);
  });

  it("sealed must start with stk-handover-v1:", () => {
    expect(VERB_PARAMS["forge.api.deliver"].safeParse({ ...deliver, sealed: "ghp_plaintexttoken" }).success).toBe(false);
    expect(VERB_PARAMS["forge.api.deliver"].safeParse({ ...deliver, sealed: "" }).success).toBe(false);
    expect(VERB_PARAMS["forge.api.deliver"].safeParse({ ...deliver, sealed: "stk-handover-v1:" }).success).toBe(false);
  });

  it("unknown capability is not silently dropped", () => {
    expect(Capability.parse("forge.api")).toBe("forge.api");
    expect(CapabilityList.parse(["forge.api", "nope"])).toEqual(["forge.api"]);
    expect(unknownCapabilitiesByStation([{ key: "k", capabilities: ["forge.api", "nope"] }])).toEqual([{ key: "k", dropped: ["nope"] }]);
  });

  it("VERB_RESULTS has an entry for every forge.api verb", () => {
    for (const v of VERBS) expect(VERB_RESULTS[v]).toBeDefined();
    expect(VERB_RESULTS["forge.api.deliver"].parse({ ok: true, isolation: "separate-user", stored: true })).toBeTruthy();
    expect(VERB_RESULTS["forge.api.deliver"].safeParse({ ok: true, isolation: "other", stored: true }).success).toBe(false);
    expect(VERB_RESULTS["forge.api.verify"].parse({ ok: false, reason: "r", isolation: "same-user" })).toBeTruthy();
    expect(VERB_RESULTS["forge.api.revoke"].parse({ removed: true })).toBeTruthy();
    expect(VERB_RESULTS["forge.api.policy"].parse({ ok: false, error: "e" })).toBeTruthy();
    expect(VERB_RESULTS["forge.api.status"].parse({ grants: [{ grantId: "g", present: true, isolation: "same-user" }] })).toBeTruthy();
    // results are NOT strict: a newer node may add a field and the hub must still read the reply
    const skew = VERB_RESULTS["forge.api.deliver"].safeParse({ ok: true, isolation: "same-user", stored: true, future: 1 });
    expect(skew.success).toBe(true);
    if (skew.success) expect(skew.data).toMatchObject({ ok: true, isolation: "same-user", stored: true });
    for (const v of VERBS) expect(VERB_RESULTS[v]).toBeDefined();
    expect(VERB_RESULTS["forge.api.status"].safeParse({ grants: [{ grantId: "g", present: true, isolation: "same-user", extra: 1 }], extra: 2 }).success).toBe(true);
  });
});

describe("forge.api.status publicKey", () => {
  const S = VERB_RESULTS["forge.api.status"];
  it("status result carries the station's stk handover public key when the node has one", () => {
    const r = S.safeParse({ grants: [], publicKey: "stk-handover-v1:AAAA" });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as { publicKey?: string }).publicKey).toBe("stk-handover-v1:AAAA");
  });
  it("publicKey is optional (an older node omits it)", () => {
    expect(S.safeParse({ grants: [] }).success).toBe(true);
  });
  it("a publicKey without the stk-handover-v1: prefix is rejected", () => {
    expect(S.safeParse({ grants: [], publicKey: "ssh-ed25519 AAAA" }).success).toBe(false);
  });
});
