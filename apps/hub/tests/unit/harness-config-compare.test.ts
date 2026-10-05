import { describe, test, expect } from "bun:test";
import { compare } from "../../src/services/harness-config";

const SETTING = {
  id: "hermes.approvals.timeout", harness: "hermes", scope: "profile" as const,
  policy: "reconcilable" as const, restartToTakeEffect: true,
};
const base = { stationId: "station_a", settings: [SETTING] };

/** A `Resolved` fixture — `resolveFor`'s shape, value and the level it came from. */
function at(value: unknown, level: "station" | "node" | "fleet") {
  return { value, level };
}

describe("comparing a station against the declaration", () => {
  test("equal values match", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: at("900", "station") }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("different values drift, and the reason names both", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: at("900", "station") }, values: [{ settingId: SETTING.id, readable: true, observed: "300" }] });
    expect(o.state).toBe("drifted");
    expect(o.reason).toContain("900");
    expect(o.reason).toContain("300");
  });

  test("declared values compare by value, not by type — 900 and \"900\" agree", () => {
    // The node reads YAML as text; a declaration arrives as JSON. Treating these
    // as different would report drift on every numeric setting, forever.
    const [o] = compare({ ...base, declared: { [SETTING.id]: at(900, "station") }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("declared but absent from the document is `absent`, not `drifted`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: at("900", "station") }, values: [{ settingId: SETTING.id, readable: true }] });
    expect(o.state).toBe("absent");
  });

  test("an unreadable document is `unreadable` — never `matches` and never `absent`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: at("900", "station") }, values: [{ settingId: SETTING.id, readable: false, reason: "no such file" }] });
    expect(o.state).toBe("unreadable");
    expect(o.reason).toContain("no such file");
  });

  test("a setting nobody declared is not reported at all", () => {
    expect(compare({ ...base, declared: {}, values: [{ settingId: SETTING.id, readable: true, observed: "300" }] })).toEqual([]);
  });

  test("a station-scoped declaration for a user-scoped setting is out-of-scope", () => {
    const userScoped = { ...SETTING, id: "openclaw.hooks.allowConversationAccess", harness: "openclaw", scope: "user" as const };
    const [o] = compare({
      stationId: "station_a", settings: [userScoped],
      declared: { [userScoped.id]: { value: true, level: "station" as const } },
      values: [{ settingId: userScoped.id, readable: true, observed: true }],
    });
    expect(o.state).toBe("out-of-scope");
  });
});

describe("awaiting-restart: restart evidence comes from the gateway pid, never a timer", () => {
  const NO_RESTART_SETTING = { ...SETTING, id: "hermes.approvals.autoApproveList", restartToTakeEffect: false };

  test("a setting written under a gateway pid that is still running is awaiting-restart", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 100,
    });
    expect(o.state).toBe("awaiting-restart");
  });

  test("the same setting after the gateway pid changed is matches", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 200,
    });
    expect(o.state).toBe("matches");
  });

  test("a station whose health reports no pid stays awaiting-restart, never matches", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: null,
    });
    expect(o.state).toBe("awaiting-restart");
  });

  test("a setting that needs no restart is `matches` immediately after a write", () => {
    const [o] = compare({
      stationId: "station_a",
      settings: [NO_RESTART_SETTING],
      declared: { [NO_RESTART_SETTING.id]: at("900", "station") },
      values: [{ settingId: NO_RESTART_SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [NO_RESTART_SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 100,
    });
    expect(o.state).toBe("matches");
  });

  test("a setting written when health could not be read stays awaiting-restart, never matches", () => {
    // `applyFor` records `gatewayPid: null` whenever the post-write `health`
    // round trip times out or does not parse. A null RECORDED pid is no
    // evidence of a restart, exactly as a null CURRENT pid is not — and with
    // the ordinary comparison reached, this row reports `matches`: a file
    // saying 900 and a gateway still enforcing 300, reported as agreement.
    // That is spec F4's worse error, on the other side of the comparison.
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: null } },
      currentGatewayPid: 4242,
    });
    expect(o.state).toBe("awaiting-restart");
    expect(o.reason).toContain("could not be confirmed");
  });

  test("neither pid known is still awaiting-restart", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: null } },
      currentGatewayPid: null,
    });
    expect(o.state).toBe("awaiting-restart");
  });
});

/**
 * Precedence is an ORDERED list in `compare()`'s own doc comment:
 *
 *   1. out-of-scope  2. unreadable  3. opted-out  4. awaiting-restart
 *   5. absent / drifted / matches
 *
 * A reordering is a defect, so every ADJACENT pair gets a fixture where both
 * conditions hold at once and the higher one must win. Without these, moving
 * `opted-out` above `unreadable`, `awaiting-restart` above `opted-out`, or
 * `unreadable` above `out-of-scope` fails no test.
 */
describe("precedence: every adjacent pair, with both conditions true at once", () => {
  const USER_SCOPED = { ...SETTING, id: "openclaw.hooks.allowConversationAccess", harness: "openclaw", scope: "user" as const };

  test("out-of-scope beats unreadable", () => {
    const [o] = compare({
      stationId: "station_a",
      settings: [USER_SCOPED],
      declared: { [USER_SCOPED.id]: at(true, "station") },
      values: [{ settingId: USER_SCOPED.id, readable: false, reason: "no such file" }],
    });
    expect(o.state).toBe("out-of-scope");
  });

  test("unreadable beats opted-out: a document nobody could read is not an operator's choice", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: false, reason: "no such file" }],
      optedOut: new Set([SETTING.id]),
    });
    expect(o.state).toBe("unreadable");
  });

  test("opted-out beats awaiting-restart: the operator's choice outranks our own write", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 100,
      optedOut: new Set([SETTING.id]),
    });
    expect(o.state).toBe("opted-out");
  });

  test("awaiting-restart beats the ordinary comparison, drifted included", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      // The document does not even agree yet — and the write is still
      // unconfirmed, which is what the state has to name.
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 100,
    });
    expect(o.state).toBe("awaiting-restart");
  });
});

describe("opted-out: an explicit operator choice, not a key in the harness's own document", () => {
  test("an opted-out setting is `opted-out` even when the observed value differs", () => {
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    });
    expect(o.state).toBe("opted-out");
  });

  test("opted-out beats drifted: the state names the operator's choice, not the diff", () => {
    // Same inputs as the plain "different values drift" case above — the
    // only difference is the opt-out. If precedence collapsed (drifted
    // decided before opted-out), this would report `drifted` instead.
    const [o] = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    });
    expect(o.state).toBe("opted-out");
  });

  test("clearing an opt-out returns the setting to ordinary comparison", () => {
    const stillOptedOut = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    })[0]!;
    expect(stillOptedOut.state).toBe("opted-out");

    // The opt-out row was deleted (`clearOptOut`) — the caller now passes an
    // empty set, and the same observed/declared pair reads as ordinary drift.
    const afterClearing = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set(),
    })[0]!;
    expect(afterClearing.state).toBe("drifted");
  });
});

/**
 * D11: a harness's own opt-out (ConfigValue.optedOutByHarness — Hermes'
 * plugins.disabled) must reach `compare()` as `opted-out`, exactly as the
 * hub's own register does — but the two sources must be distinguishable in
 * the reason text, which is the whole point of carrying the field at all.
 */
describe("a harness's own opt-out (D11) is opted-out, and distinguishable from the hub's register", () => {
  test("a document reporting optedOutByHarness is opted-out, with a reason naming the harness as the source", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300", optedOutByHarness: true }],
    })[0]!;
    expect(o.state).toBe("opted-out");
    expect(o.reason).toContain("hermes");
  });

  test("a hub-register opt-out still reports its own reason, unrelated to the harness", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    })[0]!;
    expect(o.state).toBe("opted-out");
    expect(o.reason).toContain("operator opted");
  });

  test("the two reasons are textually distinguishable — an operator can tell which source fired", () => {
    const harnessReason = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300", optedOutByHarness: true }],
    })[0]!.reason!;
    const registerReason = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    })[0]!.reason!;
    expect(harnessReason).not.toBe(registerReason);
    // Neither reason's distinguishing word appears in the other.
    expect(registerReason).not.toContain("hermes");
    expect(harnessReason).not.toContain("operator opted");
  });

  test("optedOutByHarness: false (the ordinary case) is not opted-out", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900", optedOutByHarness: false }],
    })[0]!;
    expect(o.state).toBe("matches");
  });

  // D6/Task 5b gap: the tests above all exercise `harness: "hermes"` via
  // SETTING, which is generic enough to pass even if OpenClaw's own
  // descriptor never actually set `optedOutByHarness` — a reason built from
  // `setting?.harness` is a different code path for a different harness
  // name, and this is the test that proves it actually fires there too,
  // not just assumed by analogy to Hermes.
  test("the same path fires for OpenClaw's own setting, and the reason names openclaw as the source", () => {
    const openclawSetting = {
      id: "openclaw.hooks.allowConversationAccess", harness: "openclaw",
      scope: "user" as const, policy: "reconcilable" as const, restartToTakeEffect: true,
    };
    // Declared at node level, not station: this setting is user-scoped, and
    // a station-scoped declaration of it is refused out-of-scope (step 1)
    // before opted-out (step 3) is ever reached — a different test already
    // covers that refusal, above.
    const o = compare({
      stationId: "station_a",
      settings: [openclawSetting],
      declared: { [openclawSetting.id]: at(true, "node") },
      values: [{ settingId: openclawSetting.id, readable: true, observed: false, optedOutByHarness: true }],
    })[0]!;
    expect(o.state).toBe("opted-out");
    expect(o.reason).toContain("openclaw");
    expect(o.reason).not.toContain("hermes");
  });

  // Task 5b: the source must be on the OBSERVATION itself, typed, not just
  // recoverable from the reason's prose — the console used to match the
  // literal "not an agentpod exemption" suffix, which breaks the moment
  // somebody rewords the sentence. `optedOutByHarness` is the field; this
  // test fails if `compare()` ever reports the same value for both sources.
  test("ConfigObservation.optedOutByHarness names the source, not just the reason text", () => {
    const harnessSourced = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300", optedOutByHarness: true }],
    })[0]!;
    expect(harnessSourced.state).toBe("opted-out");
    expect(harnessSourced.optedOutByHarness).toBe(true);

    const registerSourced = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    })[0]!;
    expect(registerSourced.state).toBe("opted-out");
    expect(registerSourced.optedOutByHarness).toBe(false);
  });
});

/**
 * `ConfigObservation.level` carries the resolution level the winning
 * declaration came from, exactly as `resolveFor`'s `Resolved` names it —
 * so the console can stop re-deriving station → node → fleet precedence a
 * second time, client-side, in a different language.
 */
describe("level: the resolution level travels on every observation", () => {
  test("a station-level declaration reports level: station", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "station") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
    })[0]!;
    expect(o.level).toBe("station");
  });

  test("a node-level declaration reports level: node", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "node") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
    })[0]!;
    expect(o.level).toBe("node");
  });

  test("a fleet-level declaration reports level: fleet", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "fleet") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
    })[0]!;
    expect(o.level).toBe("fleet");
  });

  test("an out-of-scope observation still reports its level — the refusal does not erase it", () => {
    const userScoped = { ...SETTING, id: "openclaw.hooks.allowConversationAccess", harness: "openclaw", scope: "user" as const };
    const o = compare({
      stationId: "station_a",
      settings: [userScoped],
      declared: { [userScoped.id]: at(true, "station") },
      values: [{ settingId: userScoped.id, readable: true, observed: true }],
    })[0]!;
    expect(o.state).toBe("out-of-scope");
    expect(o.level).toBe("station");
  });

  test("an unreadable observation still reports its level", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "node") },
      values: [{ settingId: SETTING.id, readable: false, reason: "no such file" }],
    })[0]!;
    expect(o.state).toBe("unreadable");
    expect(o.level).toBe("node");
  });

  test("an opted-out observation still reports its level", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "fleet") },
      values: [{ settingId: SETTING.id, readable: true, observed: "300" }],
      optedOut: new Set([SETTING.id]),
    })[0]!;
    expect(o.state).toBe("opted-out");
    expect(o.level).toBe("fleet");
  });

  test("an awaiting-restart observation still reports its level", () => {
    const o = compare({
      ...base,
      declared: { [SETTING.id]: at("900", "node") },
      values: [{ settingId: SETTING.id, readable: true, observed: "900" }],
      appliedWrites: { [SETTING.id]: { gatewayPid: 100 } },
      currentGatewayPid: 100,
    })[0]!;
    expect(o.state).toBe("awaiting-restart");
    expect(o.level).toBe("node");
  });
});
