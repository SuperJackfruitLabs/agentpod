import { describe, test, expect } from "bun:test";
import { compare } from "../../src/services/harness-config";

const SETTING = {
  id: "hermes.approvals.timeout", harness: "hermes", scope: "profile" as const,
  policy: "reconcilable" as const, restartToTakeEffect: true,
};
const base = { stationId: "station_a", settings: [SETTING] };

describe("comparing a station against the declaration", () => {
  test("equal values match", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("different values drift, and the reason names both", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true, observed: "300" }] });
    expect(o.state).toBe("drifted");
    expect(o.reason).toContain("900");
    expect(o.reason).toContain("300");
  });

  test("declared values compare by value, not by type — 900 and \"900\" agree", () => {
    // The node reads YAML as text; a declaration arrives as JSON. Treating these
    // as different would report drift on every numeric setting, forever.
    const [o] = compare({ ...base, declared: { [SETTING.id]: 900 }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("declared but absent from the document is `absent`, not `drifted`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true }] });
    expect(o.state).toBe("absent");
  });

  test("an unreadable document is `unreadable` — never `matches` and never `absent`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: false, reason: "no such file" }] });
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
      declared: { [userScoped.id]: true }, values: [{ settingId: userScoped.id, readable: true, observed: true }],
      declaredAtStationLevel: new Set([userScoped.id]),
    });
    expect(o.state).toBe("out-of-scope");
  });
});
