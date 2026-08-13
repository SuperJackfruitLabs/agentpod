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
import { join } from "node:path";

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

// ─── Modal ────────────────────────────────────────────────────────────────────

/**
 * Modal is the first substrate the hub can misconfigure into silence rather
 * than into an error. A missing token fails loudly on the first call; a missing
 * or local IMAGE does not — Modal pulls from a registry, so `agentpod-node:local`
 * produces a sandbox that never boots, a runtime that sits in `provisioning`,
 * and a sweeper message two minutes later that names nothing. And an unset
 * PROVISIONING_HUB_URL breaks nothing until the first 24-hour rotation, a day
 * after anyone was watching.
 *
 * All four are therefore boot refusals, and all four are conditional on the
 * provider being enabled: the live hub runs `docker, cloudflare` and must keep
 * booting untouched.
 */

const withModal = (
  over: Partial<typeof config.modal>,
  provisioningHubUrl = "https://hub.example"
) =>
  ({
    ...config,
    modal: { ...config.modal, ...over },
    provisioningHubUrl,
  }) as typeof config;

const fieldsFor = (cfg: typeof config) =>
  collectConfigErrors(cfg, quiet).map((e) => e.field);

const messageFor = (cfg: typeof config, field: string) =>
  collectConfigErrors(cfg, quiet).find((e) => e.field === field)?.message ?? "";

const CONFIGURED = {
  enabled: true,
  tokenId: "tok-id",
  tokenSecret: "tok-secret",
  image: "ghcr.io/example/agentpod-node-modal:v1",
} as const;

describe("validateConfig — modal", () => {
  it("accepts a fully configured Modal hub", () => {
    const fields = fieldsFor(withModal(CONFIGURED));
    expect(fields).not.toContain("MODAL_TOKEN_ID");
    expect(fields).not.toContain("MODAL_TOKEN_SECRET");
    expect(fields).not.toContain("NODE_AGENT_MODAL_IMAGE");
    expect(fields).not.toContain("PROVISIONING_HUB_URL");
  });

  it("requires both tokens, reported together", () => {
    const fields = fieldsFor(
      withModal({ ...CONFIGURED, tokenId: "", tokenSecret: "" })
    );
    expect(fields).toContain("MODAL_TOKEN_ID");
    expect(fields).toContain("MODAL_TOKEN_SECRET");
  });

  it("reports each half of the pair on its own", () => {
    // The interesting deploy is half-configured, not empty. Reporting the pair
    // as one error would send an operator to re-check a variable that was
    // already right; reporting neither until both are missing is worse.
    const idOnly = fieldsFor(withModal({ ...CONFIGURED, tokenSecret: "" }));
    expect(idOnly).toContain("MODAL_TOKEN_SECRET");
    expect(idOnly).not.toContain("MODAL_TOKEN_ID");

    const secretOnly = fieldsFor(withModal({ ...CONFIGURED, tokenId: "" }));
    expect(secretOnly).toContain("MODAL_TOKEN_ID");
    expect(secretOnly).not.toContain("MODAL_TOKEN_SECRET");
  });

  it("names the flag that made each variable required", () => {
    // The whole value of a boot refusal over a stack trace is that it tells an
    // operator which switch put them here.
    const fields = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "NODE_AGENT_MODAL_IMAGE"];
    const broken = withModal({ enabled: true, tokenId: "", tokenSecret: "", image: "" });
    for (const field of fields) {
      expect(messageFor(broken, field)).toMatch(/ENABLE_MODAL_PROVISIONING/);
    }
  });

  it("requires a registry image Modal can actually pull", () => {
    // The Docker-first default is `agentpod-node:local`, which Modal cannot
    // pull. Unset or local, the runtime provisions "successfully" and then
    // never produces a node — a two-minute wait ending in a sweeper message
    // that names nothing.
    expect(fieldsFor(withModal({ ...CONFIGURED, image: "" }))).toContain(
      "NODE_AGENT_MODAL_IMAGE"
    );
    expect(
      fieldsFor(withModal({ ...CONFIGURED, image: "agentpod-node:local" }))
    ).toContain("NODE_AGENT_MODAL_IMAGE");
  });

  it("requires PROVISIONING_HUB_URL, because rotation runs without a request", () => {
    // A rotating substrate re-creates instances on a timer. With no request to
    // take an origin from, an unset value would turn every 24h rotation into an
    // error — a day after anyone was watching.
    expect(fieldsFor(withModal(CONFIGURED, ""))).toContain("PROVISIONING_HUB_URL");
  });

  it("leaves a hub with Modal disabled alone", () => {
    // Conditional for the same reason as the Cloudflare rule above: a hub that
    // never registers this driver must not need its variables to boot.
    const fields = fieldsFor(
      withModal({ enabled: false, tokenId: "", tokenSecret: "", image: "" }, "")
    );
    expect(fields).not.toContain("MODAL_TOKEN_ID");
    expect(fields).not.toContain("MODAL_TOKEN_SECRET");
    expect(fields).not.toContain("NODE_AGENT_MODAL_IMAGE");
    expect(fields).not.toContain("PROVISIONING_HUB_URL");
  });

  // ── The rules above are exercised against a hand-built config object, which
  // never runs config.ts's env parsing. That leaves the VARIABLE NAMES untested
  // — an operator can set every documented variable correctly and still be
  // refused, and no object-level test can see it. These two load config in a
  // CHILD PROCESS with a controlled environment, which is the only way to
  // observe module-scope env parsing from a suite that shares one module
  // registry.

  /** Real config, loaded fresh under `overrides` (a `null` value unsets). */
  const collectInChild = (overrides: Record<string, string | null>) => {
    const hubRoot = join(import.meta.dir, "..", "..");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Every Modal variable starts UNSET, so a test that wants one says so.
    for (const key of [
      "ENABLE_MODAL_PROVISIONING",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "MODAL_APP_NAME",
      "NODE_AGENT_MODAL_IMAGE",
      "NODE_AGENT_IMAGE",
      "PROVISIONING_HUB_URL",
    ]) {
      delete env[key];
    }
    env.NODE_ENV = "development";
    // Set because the built-in default is 33 characters and therefore always an
    // error — a pre-existing quirk unrelated to Modal, and the only thing
    // standing between these hubs and a clean boot.
    env.ENCRYPTION_KEY = "k7Qm2xR9tP4wL6vB8nZ3sJ5hD1yF0gC-";
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete env[key];
      else env[key] = value;
    }

    const script = `
      const { collectConfigErrors } = await import(${JSON.stringify(
        join(hubRoot, "src", "utils", "validate-config.ts")
      )});
      const { config } = await import(${JSON.stringify(
        join(hubRoot, "src", "config.ts")
      )});
      console.log(JSON.stringify({
        modal: config.modal,
        provisioningHubUrl: config.provisioningHubUrl,
        fields: collectConfigErrors(undefined, () => {}).map((e) => e.field),
      }));
    `;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: hubRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    // A child that died took the assertion with it — say so rather than
    // reporting a confusing parse failure.
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    return JSON.parse(proc.stdout.toString().trim().split("\n").at(-1)!) as {
      modal: { enabled: boolean; tokenId: string; tokenSecret: string; image: string; appName: string };
      provisioningHubUrl: string;
      fields: string[];
    };
  };

  it("boots the live hub's shape — docker + cloudflare, ENABLE_MODAL_PROVISIONING UNSET", () => {
    // The deployment this must not break does not set the flag to "false"; it
    // has never heard of it. That distinction is invisible to a test that
    // hand-builds `{ enabled: false }`.
    const result = collectInChild({
      ENABLE_DOCKER_PROVISIONING: "true",
      ENABLE_CLOUDFLARE_SANDBOXES: "true",
      CLOUDFLARE_SANDBOX_IMAGE: "agentpod-node-opencode:local",
      ENABLE_MODAL_PROVISIONING: null,
    });
    expect(result.modal.enabled).toBe(false);
    expect(result.fields).not.toContain("MODAL_TOKEN_ID");
    expect(result.fields).not.toContain("MODAL_TOKEN_SECRET");
    expect(result.fields).not.toContain("NODE_AGENT_MODAL_IMAGE");
    expect(result.fields).not.toContain("PROVISIONING_HUB_URL");
    // And nothing else refuses either: this hub boots.
    expect(result.fields).toEqual([]);
  });

  it("boots a Modal hub configured with the documented variable names", () => {
    // This is the test that catches a config.ts reading the wrong env var —
    // e.g. taking the image from Docker's NODE_AGENT_IMAGE. Every rule above
    // would still pass, and an operator who set exactly what DEPLOYMENT.md says
    // would be refused at boot with a message naming a variable they had set.
    const result = collectInChild({
      ENABLE_MODAL_PROVISIONING: "true",
      MODAL_TOKEN_ID: "ak-live-id",
      MODAL_TOKEN_SECRET: "as-live-secret",
      NODE_AGENT_MODAL_IMAGE: "ghcr.io/example/agentpod-node-modal:v1",
      MODAL_APP_NAME: "agentpod-prod",
      PROVISIONING_HUB_URL: "https://hub.example",
    });
    expect(result.modal).toEqual({
      enabled: true,
      tokenId: "ak-live-id",
      tokenSecret: "as-live-secret",
      image: "ghcr.io/example/agentpod-node-modal:v1",
      appName: "agentpod-prod",
    });
    expect(result.provisioningHubUrl).toBe("https://hub.example");
    expect(result.fields).toEqual([]);
  });
});
