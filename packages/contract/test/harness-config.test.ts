import { describe, test, expect } from "bun:test";
import {
  ConfigScope, ConfigPolicy, ConfigSetting, DeclaredSetting, ConfigValue, ConfigObservation,
  ConfigPlan, ConfigReceipt, ConfigRefusalCode, ConfigWritten,
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

  test("optedOutByHarness is optional, and absent is not the same as declaring false", () => {
    // A value with no opinion at all — the common case, every reader that has
    // never seen `plugins.disabled` mentioned.
    expect(ConfigValue.safeParse({ settingId: "x", readable: true, observed: "900" }).success).toBe(true);
    const seen = ConfigValue.parse({
      settingId: "x", readable: true, observed: "900", optedOutByHarness: true,
    });
    expect(seen.optedOutByHarness).toBe(true);
  });

  test("a declaration's value must be present — omitting it is not a literal null", () => {
    // compare() reads a declared-but-undefined value back as permanently
    // `drifted`, with nothing a station could ever observe able to satisfy
    // it. Removing a declaration is DELETE's job, not an absent `value`.
    expect(DeclaredSetting.safeParse({
      settingId: "hermes.approvals.timeout", stationId: null, nodeId: null,
    }).success).toBe(false);
    // A literal `null` is a real, present value and must still be accepted
    // — only OMISSION is refused.
    expect(DeclaredSetting.safeParse({
      settingId: "hermes.approvals.timeout", stationId: null, nodeId: null, value: null,
    }).success).toBe(true);
  });

  test("observation states are closed, and include every honest non-match", () => {
    for (const state of [
      "matches", "drifted", "absent", "opted-out", "awaiting-restart", "unreadable", "out-of-scope",
    ]) {
      expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state, level: "station" }).success)
        .toBe(true);
    }
    expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "ok", level: "station" }).success)
      .toBe(false);
  });

  test("an observation's level is required — an omitted one must not read as any default", () => {
    // Every branch in `compare()` has a resolved level in hand before it ever
    // builds a row (see the field's own doc comment). An observation with no
    // level is not a real shape this system produces.
    expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "matches" }).success).toBe(false);
  });

  test("level is a closed vocabulary of exactly the three resolution levels", () => {
    for (const level of ["station", "node", "fleet"]) {
      expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "matches", level }).success)
        .toBe(true);
    }
    expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "matches", level: "profile" }).success)
      .toBe(false);
  });
});

describe("a config plan is reviewable before it is applied", () => {
  const entry = {
    settingId: "hermes.approvals.timeout",
    file: "/home/x/.hermes/profiles/p/config.yaml",
    keyPath: "approvals.timeout",
    policy: "reconcilable" as const,
    current: 300,
    intended: 900,
    action: "modify" as const,
    restartToTakeEffect: true,
  };

  test("a plan carries its digest and the document it was derived from", () => {
    const plan = ConfigPlan.parse({
      schemaVersion: 1,
      operationId: "op_1",
      stationKey: "p",
      entries: [entry],
      beforeSha256: "a".repeat(64),
      diff: "-  timeout: 300\n+  timeout: 900\n",
      diffTruncated: false,
      noOp: false,
      restartRequired: true,
      createdAt: "2026-10-05T00:00:00.000Z",
      planDigest: "b".repeat(64),
    });
    expect(plan.entries[0]?.intended).toBe(900);
    expect(plan.refusal).toBeUndefined();
  });

  test("a refused plan names a code from the registry of refusals, and writes nothing", () => {
    const plan = ConfigPlan.parse({
      schemaVersion: 1, operationId: "op_2", stationKey: "p", entries: [],
      beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: true,
      restartRequired: false, createdAt: "2026-10-05T00:00:00.000Z", planDigest: "c".repeat(64),
      refusal: { code: "CREDENTIAL_PATH", message: "the target resolves to a credential file" },
    });
    expect(plan.refusal?.code).toBe("CREDENTIAL_PATH");
    // A refusal never carries a restart claim.
    expect(plan.restartRequired).toBe(false);
  });

  test("every refusal code in the spec is representable, and nothing else is", () => {
    for (const code of ["UNKNOWN_SETTING", "OUT_OF_SCOPE", "SHAPE_UNEXPECTED",
      "PLAN_STALE", "PLAN_DIGEST_MISMATCH", "OPTED_OUT", "UNREADABLE", "CREDENTIAL_PATH"]) {
      expect(ConfigRefusalCode.parse(code)).toBe(code);
    }
    expect(ConfigRefusalCode.safeParse("WHATEVER").success).toBe(false);
  });

  test("a receipt records what was written, per entry, and never claims a restart happened", () => {
    const receipt = ConfigReceipt.parse({
      plan: {
        schemaVersion: 1, operationId: "op_1", stationKey: "p", entries: [entry],
        beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: false,
        restartRequired: true, createdAt: "2026-10-05T00:00:00.000Z", planDigest: "b".repeat(64),
      },
      phase: "applied",
      updatedAt: "2026-10-05T00:00:01.000Z",
      written: [{ settingId: "hermes.approvals.timeout", action: "modify", wrote: 900 }],
      afterSha256: "d".repeat(64),
    });
    expect(receipt.phase).toBe("applied");
    expect(receipt.written[0]?.wrote).toBe(900);
  });

  test("D4: no shape in this contract has a `restarted` field, and one cannot be smuggled in", () => {
    // `expect(receipt).not.toHaveProperty("restarted")` on a parsed fixture
    // asserted nothing: zod strips unknown keys, so it held for any
    // `restarted: z.boolean().optional()` someone added later and only failed
    // for a REQUIRED one, which nobody would add. The schema itself is what
    // has to be checked — this fails the moment a `restarted` field is
    // declared, optional or not.
    expect(Object.keys(ConfigReceipt.shape)).not.toContain("restarted");
    expect(Object.keys(ConfigPlan.shape)).not.toContain("restarted");
    expect(Object.keys(ConfigWritten.shape)).not.toContain("restarted");
    // And the stripping itself: a node that sent one would have it dropped,
    // not passed through to a caller who might believe it.
    const parsed = ConfigReceipt.parse({
      plan: {
        schemaVersion: 1, operationId: "op_1", stationKey: "p", entries: [entry],
        beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: false,
        restartRequired: true, createdAt: "2026-10-05T00:00:00.000Z", planDigest: "b".repeat(64),
      },
      phase: "applied",
      updatedAt: "2026-10-05T00:00:01.000Z",
      written: [],
      restarted: true,
    });
    expect(parsed).not.toHaveProperty("restarted");
  });

  test("restartRequired is required, not defaulted — F4's asymmetry is not a default", () => {
    // The old assertion read back the literal the test itself had just passed
    // into `parse`. What is worth pinning is that the field cannot be OMITTED:
    // a plan that forgot to say would otherwise claim no restart is needed,
    // which spec §7 names as the worse of the two errors.
    const withoutIt = {
      schemaVersion: 1, operationId: "op_3", stationKey: "p", entries: [],
      beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: true,
      createdAt: "2026-10-05T00:00:00.000Z", planDigest: "c".repeat(64),
    };
    expect(ConfigPlan.safeParse(withoutIt).success).toBe(false);
    expect(ConfigSetting.safeParse({
      id: "hermes.approvals.timeout", harness: "hermes", scope: "profile", policy: "additive-only",
    }).success).toBe(false);
  });

  test("`conflict` is a phase, so a stale plan is an answer rather than a thrown error", () => {
    expect(ConfigReceipt.shape.phase.safeParse("conflict").success).toBe(true);
  });
});
