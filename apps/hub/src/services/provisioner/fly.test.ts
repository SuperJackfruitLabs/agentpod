/**
 * Unit tests: FlyMachinesProvisioner.
 *
 * No real Fly. fly-fake-substrate.ts implements the real routes in memory, and
 * every test passes `pacer: noPacer` so the suite does not spend a second per
 * call obeying a rate limit that does not exist in a fake.
 */

import { describe, it, expect } from "bun:test";
import { noPacer } from "./fly-api";
import {
  FlyMachinesProvisioner,
  formatFlyExternalId,
  parseFlyExternalId,
} from "./fly";

describe("FlyMachinesProvisioner — declarations", () => {
  const make = () =>
    new FlyMachinesProvisioner({
      credentials: { get: () => "fly-token" },
      pacer: noPacer,
    });

  it("declares what was MEASURED on a real Fly account, not what the docs claim", () => {
    const m = make().manifest;

    // 2026-08-12: a sentinel written to / was GONE after stop→start; the same
    // sentinel on a mounted volume survived. persist_rootfs is not used — Fly's
    // own docs disclaim it for critical data.
    expect(m.workspaceStorage).toBe("volume");
    // The machine id and the volume both survived stop→start.
    expect(m.stopSemantics).toBe("resumable");
    // Fly destroys nothing for age.
    expect(m.maxLifetimeMs).toBeNull();
    // Unlike Cloudflare, config.image is per machine.
    expect(m.imageBinding).toBe("per-instance");
    // config.guest is per machine too, so all three tiers are real.
    expect(m.supportedTiers).toEqual(["small", "medium", "large"]);
    // 2026-08-12: 25 minutes idle with only outbound traffic, sampled every 5
    // minutes, `started` throughout. Autostop is Fly-Proxy-driven and only
    // touches machines with inbound `services`; this driver defines none.
    expect(m.idleBehaviour).toBe("hub-driven");
    expect(m.lifecycle).toEqual(expect.arrayContaining(["start", "stop", "status"]));
  });

  it("names itself so the registry gates it on ENABLE_FLY_PROVISIONING", () => {
    expect(make().provider).toBe("fly");
    expect(make().manifest.provider).toBe("fly");
  });

  it("REFUSES TO CONSTRUCT without a Fly token, naming the variable", () => {
    // A missing credential is a startup-time refusal to register, not a runtime
    // failure on a user's first provisioning attempt.
    expect(
      () => new FlyMachinesProvisioner({ credentials: { get: () => undefined }, pacer: noPacer })
    ).toThrow(/FLY_API_TOKEN/);
  });

  it("treats an empty token as missing", () => {
    // Deploy platforms surface an unset secret as "". Handing the driver a
    // blank token only moves the failure to the first API call, where it reads
    // as an auth problem rather than a configuration one.
    expect(
      () => new FlyMachinesProvisioner({ credentials: { get: () => "" }, pacer: noPacer })
    ).toThrow(/FLY_API_TOKEN/);
  });
});

describe("fly external ids", () => {
  it("carries both halves of the handle, because a machine id alone is not addressable", () => {
    // Every Fly route is /v1/apps/{app}/machines/{id}. The hub stores ONE
    // string, so it has to be both.
    expect(formatFlyExternalId("agentpod-rt-abc", "17811953b12345")).toBe(
      "agentpod-rt-abc/17811953b12345"
    );
    expect(parseFlyExternalId("agentpod-rt-abc/17811953b12345")).toEqual({
      app: "agentpod-rt-abc",
      machineId: "17811953b12345",
    });
  });

  it("refuses a malformed id rather than building a nonsense URL", () => {
    expect(() => parseFlyExternalId("no-slash-here")).toThrow(/malformed external id/);
    expect(() => parseFlyExternalId("/machine-only")).toThrow(/malformed external id/);
    expect(() => parseFlyExternalId("app-only/")).toThrow(/malformed external id/);
  });
});
