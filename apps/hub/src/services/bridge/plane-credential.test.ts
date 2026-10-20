import { test, expect } from "bun:test";
import { createBridgePlaneCredential } from "./plane-credential";
const source = {
  version: 1,
  kind: "station-plane",
  principalId: "prn_aaaaaaaaaaaaaaaaaaaa",
  organizationId: "org_00000000000000000000",
  audience: "https://app.superpipeline.dev",
} as const;
const snapshot = {
  revision: "r",
  principalId: source.principalId,
  org: "org_00000000000000000000",
  owner: "human",
  enabled: true,
};
const claims = {
  sub: source.principalId,
  principalKind: "agent",
  org: snapshot.org,
  ent: ["superpipeline"],
  scope: "claim run",
  exp: Date.now() / 1000 + 300,
};
test("fresh exchange on every request, no cached bearer", async () => {
  let n = 0;
  const token = createBridgePlaneCredential(source, snapshot, {
    snapshot: async () => snapshot,
    exchange: async () => ({ accessToken: `t${++n}`, expiresIn: 300 }),
    verify: async () => claims as never,
  });
  expect(await token()).toBe("t1");
  expect(await token()).toBe("t2");
});
for (const field of ["revision", "principalId", "org", "owner", "enabled"])
  test(`rejects changed ${field} across exchange`, async () => {
    let n = 0;
    const token = createBridgePlaneCredential(source, snapshot, {
      snapshot: async () =>
        ++n === 1
          ? snapshot
          : { ...snapshot, [field]: field === "enabled" ? false : "changed" },
      exchange: async () => ({ accessToken: "token", expiresIn: 300 }),
      verify: async () => claims as never,
    });
    await expect(token()).rejects.toThrow();
  });
for (const patch of [
  { sub: "prn_bbbbbbbbbbbbbbbbbbbb" },
  { principalKind: "human" },
  { org: "org_11111111111111111111" },
  { ent: [] },
  { scope: "run" },
  { exp: 1 },
])
  test(`refuses invalid exchange claims ${JSON.stringify(patch)}`, async () => {
    const token = createBridgePlaneCredential(source, snapshot, {
      snapshot: async () => snapshot,
      exchange: async () => ({ accessToken: "token", expiresIn: 300 }),
      verify: async () => ({ ...claims, ...patch }) as never,
    });
    await expect(token()).rejects.toThrow();
  });
test("revoked exchange never returns a bearer", async () => {
  const token = createBridgePlaneCredential(source, snapshot, {
    snapshot: async () => snapshot,
    exchange: async () => {
      throw Error("suspended");
    },
    verify: async () => claims as never,
  });
  await expect(token()).rejects.toThrow();
});
