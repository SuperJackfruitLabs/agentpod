import { describe, expect, test } from "bun:test";

import { makeFingerprint } from "./fingerprint";
import { fingerprintWithin, profileFromStationKey } from "./station-fingerprint";

const ALL_UNKNOWN = makeFingerprint({}, "hub");

describe("profileFromStationKey", () => {
  test("a harness's root station is its default profile", () => {
    expect(profileFromStationKey("hermes", "hermes")).toBe("default");
  });
  test("hermes:<profile> names the profile", () => {
    expect(profileFromStationKey("hermes", "hermes:press")).toBe("press");
  });
  test("a key in no recognised shape is kept whole rather than guessed at", () => {
    expect(profileFromStationKey("codex", "/srv/work/repo")).toBe("/srv/work/repo");
    expect(profileFromStationKey("hermes", "hermes:")).toBe("hermes:");
  });
});

describe("fingerprintWithin — an attempt never waits on its fingerprint", () => {
  test("a resolver that never answers yields unknown in time", async () => {
    const started = Date.now();
    const f = await fingerprintWithin(() => new Promise(() => {}), 20);
    expect(f).toEqual(ALL_UNKNOWN);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a resolver that throws yields unknown", async () => {
    expect(await fingerprintWithin(() => Promise.reject(new Error("db down")), 1_000)).toEqual(ALL_UNKNOWN);
  });

  test("a resolver that throws synchronously yields unknown", async () => {
    const f = await fingerprintWithin(() => {
      throw new Error("sync");
    }, 1_000);
    expect(f).toEqual(ALL_UNKNOWN);
    expect(f.reported_by).toBe("hub");
  });

  test("a resolver that answers is believed", async () => {
    const f = makeFingerprint({ harness: "hermes", profile: "press", skill_release: "none" }, "hub");
    expect(await fingerprintWithin(async () => f, 1_000)).toEqual(f);
  });
});
