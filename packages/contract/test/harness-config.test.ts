import { describe, test, expect } from "bun:test";
import {
  ConfigScope, ConfigPolicy, ConfigSetting, DeclaredSetting, ConfigValue, ConfigObservation,
} from "../src/harness-config";

describe("harness config contract", () => {
  test("a setting declares its harness, scope, policy and restart need", () => {
    const parsed = ConfigSetting.parse({
      id: "hermes.approvals.timeout",
      harness: "hermes",
      scope: "profile",
      policy: "reconcilable",
      restartToTakeEffect: true,
    });
    expect(parsed.id).toBe("hermes.approvals.timeout");
  });

  test("scope and policy are closed vocabularies", () => {
    expect(ConfigScope.safeParse("profile").success).toBe(true);
    expect(ConfigScope.safeParse("station").success).toBe(false);
    expect(ConfigPolicy.safeParse("additive-only").success).toBe(true);
    expect(ConfigPolicy.safeParse("overwrite").success).toBe(false);
  });

  test("restartToTakeEffect is required — an omitted one must not read as false", () => {
    // Spec F4: claiming no restart is needed when one is produces the drift this
    // whole design exists to end, so the field may not default.
    const r = ConfigSetting.safeParse({
      id: "x", harness: "hermes", scope: "profile", policy: "reconcilable",
    });
    expect(r.success).toBe(false);
  });

  test("a declaration targets exactly one scope level", () => {
    const fleet = DeclaredSetting.parse({
      settingId: "hermes.approvals.timeout", stationId: null, nodeId: null, value: 900,
    });
    expect(fleet.stationId).toBeNull();
    // Both set is not a level — it is two.
    expect(DeclaredSetting.safeParse({
      settingId: "x", stationId: "station_1", nodeId: "node_1", value: 1,
    }).success).toBe(false);
  });

  test("an unreadable value carries no observed value", () => {
    expect(ConfigValue.parse({ settingId: "x", readable: false, reason: "not valid YAML" }).observed)
      .toBeUndefined();
    // `readable` may not default: a reader that forgot to set it must not report success.
    expect(ConfigValue.safeParse({ settingId: "x" }).success).toBe(false);
  });

  test("observation states are closed, and include every honest non-match", () => {
    for (const state of [
      "matches", "drifted", "absent", "opted-out", "awaiting-restart", "unreadable", "out-of-scope",
    ]) {
      expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state }).success).toBe(true);
    }
    expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "ok" }).success).toBe(false);
  });
});
