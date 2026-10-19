import { expect, test } from "bun:test";
import { SalaamAuthority } from "./salaam-authority";
import fixture from "./fixtures/salaam-authority-v1.json";

test("Salaam authority v1 rejects omitted, stale-shaped and caller-invented authority fields", () => {
  expect(SalaamAuthority.parse(fixture)).toEqual(fixture);
  for (const [key, value] of Object.entries({
    organization_id: "fleet_wrong",
    principal_id: "human",
    occupancy_epoch: 0,
    run: { ...fixture.run, epoch: -1 },
    station_key: "pi:other",
  }))
    expect(
      SalaamAuthority.safeParse({ ...fixture, [key]: value }).success,
    ).toBe(false);
  expect(
    SalaamAuthority.safeParse({ ...fixture, mayDispatch: ["*"] }).success,
  ).toBe(false);
  const { principal_id, ...missing } = fixture;
  expect(SalaamAuthority.safeParse(missing).success).toBe(false);
});
