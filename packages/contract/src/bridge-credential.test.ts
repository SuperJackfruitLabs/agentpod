import { expect, test } from "bun:test";
import { BridgeCredentialSource, BridgeCredentialSourceRequest, bridgeCredentialSourceFor } from "./bridge-credential";
const PRODUCTION = "https://app.superpipeline.dev";
const STAGING = "https://staging-app.superpipeline.dev";
const valid = {
  version: 1,
  kind: "station-plane",
  principalId: "prn_aaaaaaaaaaaaaaaaaaaa",
  organizationId: "org_00000000000000000000",
  audience: PRODUCTION,
};
const refusedShapes = [
  { version: 2 },
  { kind: "token" },
  { principalId: "agt_aaaaaaaaaaaaaaaa" },
  { organizationId: "fleet_00000000000000000000" },
  { audience: "http://app.superpipeline.dev" },
  { audience: "https://app.superpipeline.dev/" },
  { audience: "https://app.superpipeline.dev/mcp" },
  { audience: "https://user@app.superpipeline.dev" },
  { audience: "app.superpipeline.dev" },
  { token: "secret" },
];

test("the stored grammar accepts exact plane identities and any https origin, nothing else", () => {
  expect(BridgeCredentialSource.parse(valid)).toEqual(valid);
  expect(BridgeCredentialSource.parse({ ...valid, audience: STAGING })).toEqual({ ...valid, audience: STAGING });
  for (const patch of refusedShapes)
    expect(BridgeCredentialSource.safeParse({ ...valid, ...patch }).success).toBe(false);
});

test("a deployment admits exactly its own audience", () => {
  const staging = bridgeCredentialSourceFor(STAGING);
  expect(staging.parse({ ...valid, audience: STAGING }).audience).toBe(STAGING);
  // Production's audience is not staging's, and the reverse.
  expect(staging.safeParse(valid).success).toBe(false);
  expect(bridgeCredentialSourceFor(PRODUCTION).safeParse({ ...valid, audience: STAGING }).success).toBe(false);
  expect(bridgeCredentialSourceFor(PRODUCTION).parse(valid)).toEqual(valid);
  expect(staging.safeParse({ ...valid, audience: "https://attacker.test" }).success).toBe(false);
  for (const patch of refusedShapes)
    expect(staging.safeParse({ ...valid, audience: STAGING, ...patch }).success).toBe(false);
});

test("a deployment audience that is not an https origin admits nothing", () => {
  for (const audience of ["", "http://app.superpipeline.dev", "https://app.superpipeline.dev/", "not a url"])
    expect(() => bridgeCredentialSourceFor(audience)).toThrow();
});

test("a roster write may ask the hub to derive a source, with no identity field half-typed", () => {
  expect(BridgeCredentialSourceRequest.parse({ version: 1, kind: "station-plane" })).toEqual({ version: 1, kind: "station-plane" });
  expect(BridgeCredentialSourceRequest.parse(valid)).toEqual(valid);
  // Some identity fields but not all is neither a full source nor a request to derive one.
  expect(BridgeCredentialSourceRequest.safeParse({ version: 1, kind: "station-plane", principalId: valid.principalId }).success).toBe(false);
  expect(BridgeCredentialSourceRequest.safeParse({ version: 1, kind: "token" }).success).toBe(false);
  expect(BridgeCredentialSourceRequest.safeParse({ version: 1, kind: "station-plane", token: "secret" }).success).toBe(false);
});
