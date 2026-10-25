import { SalaamApprovalRule, SalaamAuthorityParams } from "./salaam-authority";
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

// Approval scopes B part 2: an agent's standing rules ride on admit and renew.
test("authority params may carry 1 to 16 well-formed approval rules", () => {
  const base = SalaamAuthorityParams.shape;
  expect(base.approval_rules).toBeDefined();
  const rule = { id: crypto.randomUUID(), scope: "workspace-write", set_by: "prn_owner" };
  expect(SalaamApprovalRule.safeParse(rule).success).toBe(true);
  for (const bad of [
    { ...rule, scope: "command" },
    { ...rule, extra: 1 },
    { ...rule, id: "x" },
    { ...rule, set_by: "" },
  ])
    expect(SalaamApprovalRule.safeParse(bad).success).toBe(false);
  const rules = SalaamAuthorityParams.shape.approval_rules;
  expect(rules.safeParse([rule]).success).toBe(true);
  expect(rules.safeParse(undefined).success).toBe(true);
  expect(rules.safeParse([]).success).toBe(false);
  expect(rules.safeParse(Array.from({ length: 17 }, () => ({ ...rule, id: crypto.randomUUID() }))).success).toBe(false);
  expect(rules.safeParse([rule, rule]).success).toBe(false);
});
