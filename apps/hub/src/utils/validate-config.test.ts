/**
 * Unit tests: boot-time configuration validation.
 *
 * The case that matters here is a declaration nothing enforced.
 * `cloudflare-sandbox.ts` declares `imageBinding: "fixed"` and refuses a
 * mismatched image only `if (this.deployedImage && ...)` — so a hub where
 * `CLOUDFLARE_SANDBOX_IMAGE` is unset advertises a fixed image and then honours
 * whatever it is handed, which is the original incident intact behind a missing
 * env var. The variable is documented in `cloudflare/worker-v2/README.md` and
 * set on the live hub, but nothing ever checked for it, so a fresh deploy
 * following `docs/DEPLOYMENT.md` would simply not have it.
 */

import { describe, it, expect } from "bun:test";
import { collectConfigErrors } from "./validate-config";
import { config } from "../config";

/** Swallow the dev-secret warnings the default config legitimately emits. */
const quiet = () => {};

const withCloudflare = (over: Partial<typeof config.cloudflare>) => ({
  ...config,
  cloudflare: { ...config.cloudflare, ...over },
});

const sandboxImageErrors = (cfg: typeof config) =>
  collectConfigErrors(cfg, quiet).filter((e) => e.field === "CLOUDFLARE_SANDBOX_IMAGE");

describe("validateConfig — CLOUDFLARE_SANDBOX_IMAGE", () => {
  it("refuses a Cloudflare-enabled hub that was never told its deployed image", () => {
    const errors = sandboxImageErrors(
      withCloudflare({ enabled: true, sandboxImage: "" }) as typeof config
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/ENABLE_CLOUDFLARE_SANDBOXES/);
  });

  it("accepts a Cloudflare-enabled hub that names its deployed image", () => {
    expect(
      sandboxImageErrors(
        withCloudflare({
          enabled: true,
          sandboxImage: "agentpod-node-opencode:local",
        }) as typeof config
      )
    ).toHaveLength(0);
  });

  it("leaves a Docker-only deployment alone", () => {
    // The requirement is conditional on purpose. Cloudflare provisioning is off
    // by default and off on most deployments; making every hub carry a
    // Cloudflare-only variable to boot would break them for a driver they never
    // register.
    expect(
      sandboxImageErrors(
        withCloudflare({ enabled: false, sandboxImage: "" }) as typeof config
      )
    ).toHaveLength(0);
  });
});

/**
 * Fly's configuration is checked at BOOT rather than on the first provision,
 * and that is a decision, not a habit: `FlyMachinesProvisioner`'s constructor
 * resolves FLY_API_TOKEN through `requireCredentials`, which THROWS when it is
 * missing. On a hub with ENABLE_FLY_PROVISIONING=true and no token the failure
 * is therefore already fatal — `registerEnabledProvisioners()` throws uncaught
 * out of index.ts:181. These rules add no new way to fail; they move the same
 * failure to index.ts:57 and give it a message naming the variable and the
 * command that mints one.
 *
 * Every rule below is conditional on `fly.enabled`, so a hub that never opted
 * in — which is every deployment today, all of them docker+cloudflare — sees
 * no change at all. That is asserted, not assumed, in the last test here.
 */
describe("fly provisioning config", () => {
  const withFly = (fly: Partial<typeof config.fly>) =>
    ({ ...config, fly: { ...config.fly, ...fly } }) as typeof config;

  const flyErrors = (cfg: typeof config) =>
    collectConfigErrors(cfg, quiet).filter((e) => e.field.startsWith("FLY_"));

  it("REFUSES to boot with Fly enabled and no token", () => {
    // A missing credential is a startup-time refusal, not a runtime failure on
    // a user's first provisioning attempt. Without this the hub either dies on
    // an unexplained constructor throw or — had the driver defaulted the token
    // to "" the way Cloudflare does — booted happily and failed inside
    // createRuntime, where the operator sees a 502 and no mention of a variable.
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "" }),
      quiet
    );
    expect(errors.map((e) => e.field)).toContain("FLY_API_TOKEN");
    expect(
      errors.find((e) => e.field === "FLY_API_TOKEN")!.message
    ).toMatch(/ENABLE_FLY_PROVISIONING/);
  });

  it("says nothing about Fly when Fly is off", () => {
    // A Docker-only hub must not be stopped from booting by a variable for a
    // substrate it never talks to.
    const errors = collectConfigErrors(
      withFly({ enabled: false, apiToken: "" }),
      quiet
    );
    expect(errors.map((e) => e.field)).not.toContain("FLY_API_TOKEN");
  });

  it("refuses a volume size Fly cannot create", () => {
    // Fly's minimum is 1 GB. A zero here produces a machine with a mount that
    // does not exist — i.e. a workspace on the rootfs, which is wiped on every
    // stop. That is the exact data loss this substrate was chosen to avoid.
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "fly-token", volumeSizeGb: 0 }),
      quiet
    );
    expect(errors.map((e) => e.field)).toContain("FLY_VOLUME_SIZE_GB");
  });

  it("accepts a complete Fly configuration", () => {
    const errors = collectConfigErrors(
      withFly({ enabled: true, apiToken: "fly-token", volumeSizeGb: 3 }),
      quiet
    );
    expect(errors.map((e) => e.field)).not.toContain("FLY_API_TOKEN");
    expect(errors.map((e) => e.field)).not.toContain("FLY_VOLUME_SIZE_GB");
  });

  it("adds nothing to the live hub's docker+cloudflare configuration", () => {
    // The deployed hub runs ENABLE_DOCKER_PROVISIONING + ENABLE_CLOUDFLARE_
    // SANDBOXES and has never heard of Fly. Boot-time refusal is a change to
    // hub STARTUP, so the claim that it cannot take down a healthy hub gets an
    // assertion: with Fly off, no FLY_* error exists however broken the Fly
    // half of the config is.
    const live = {
      ...config,
      cloudflare: {
        ...config.cloudflare,
        enabled: true,
        sandboxImage: "agentpod-node-opencode:local",
      },
      fly: { ...config.fly, enabled: false, apiToken: "", volumeSizeGb: 0 },
    } as typeof config;
    expect(flyErrors(live)).toEqual([]);
  });
});
