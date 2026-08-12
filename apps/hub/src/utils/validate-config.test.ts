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
