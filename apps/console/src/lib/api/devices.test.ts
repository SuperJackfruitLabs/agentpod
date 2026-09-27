import { describe, expect, it } from "vitest";
import { deviceState, lastUsedLabel, type DeviceCredential } from "./devices";

/**
 * The two pure functions the Devices screen renders through.
 *
 * Tested here rather than through the component because what can actually go
 * wrong is the classification, not the markup: a revoked device shown as
 * "expired" tells an operator their revocation did not land.
 */

const base: DeviceCredential = {
  id: "dev_0123456789abcdef0123",
  name: "this-laptop",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: "2026-12-01T00:00:00.000Z",
  revokedAt: null,
};

const NOW = Date.parse("2026-09-20T12:00:00.000Z");

describe("deviceState", () => {
  it("is active while it is neither revoked nor past its expiry", () => {
    expect(deviceState(base, NOW)).toBe("active");
  });

  it("is expired once the expiry has passed", () => {
    expect(deviceState({ ...base, expiresAt: "2026-09-19T00:00:00.000Z" }, NOW)).toBe("expired");
  });

  it("says REVOKED for a device that is both revoked and expired", () => {
    // The ordering matters and is not cosmetic. Somebody revoked this; a list
    // showing "expired" would hide the fact that their action landed, on exactly
    // the screen they went to in order to make it land.
    expect(
      deviceState(
        { ...base, expiresAt: "2026-09-19T00:00:00.000Z", revokedAt: "2026-09-18T00:00:00.000Z" },
        NOW,
      ),
    ).toBe("revoked");
  });
});

describe("lastUsedLabel", () => {
  it("distinguishes a device that has never been used", () => {
    // Not the same as "used long ago": a credential created and never exchanged
    // is one a person may not have finished setting up.
    expect(lastUsedLabel(base, NOW)).toBe("never used");
  });

  it("reads in the units a person is deciding with", () => {
    const at = (iso: string) => lastUsedLabel({ ...base, lastUsedAt: iso }, NOW);
    expect(at("2026-09-20T11:59:30.000Z")).toBe("just now");
    expect(at("2026-09-20T11:58:00.000Z")).toBe("2 minutes ago");
    expect(at("2026-09-20T11:00:00.000Z")).toBe("1 hour ago");
    expect(at("2026-09-14T12:00:00.000Z")).toBe("6 days ago");
  });

  it("says one MINUTE, not one minutes", () => {
    expect(lastUsedLabel({ ...base, lastUsedAt: "2026-09-20T11:59:00.000Z" }, NOW)).toBe("1 minute ago");
  });

  it("does not render a broken timestamp as a number of days", () => {
    expect(lastUsedLabel({ ...base, lastUsedAt: "not a date" }, NOW)).toBe("never used");
  });
});
