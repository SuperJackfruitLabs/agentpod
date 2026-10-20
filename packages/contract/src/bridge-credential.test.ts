import { expect, test } from "bun:test";
import { BridgeCredentialSource } from "./bridge-credential";
const valid = {
  version: 1,
  kind: "station-plane",
  principalId: "prn_aaaaaaaaaaaaaaaaaaaa",
  organizationId: "org_00000000000000000000",
  audience: "https://app.superpipeline.dev",
};
test("typed bridge source accepts only the exact registered product and plane identities", () => {
  expect(BridgeCredentialSource.parse(valid)).toEqual(valid);
  for (const patch of [
    { version: 2 },
    { kind: "token" },
    { principalId: "agt_aaaaaaaaaaaaaaaa" },
    { organizationId: "fleet_00000000000000000000" },
    { audience: "https://attacker.test" },
    { token: "secret" },
  ])
    expect(
      BridgeCredentialSource.safeParse({ ...valid, ...patch }).success,
    ).toBe(false);
});
