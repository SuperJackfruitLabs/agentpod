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
    expect(o.state).not.toBe("drifted");
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
