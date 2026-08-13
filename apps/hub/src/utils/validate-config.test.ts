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
    // Every provisioner variable starts UNSET, so a test that wants one says so.
    //
    // This list must cover every variable validate-config.ts can report, not
    // just Modal's. The child inherits this process's environment, and bun
    // auto-loads apps/hub/.env — a developer whose .env enables Cloudflare
    // without CLOUDFLARE_SANDBOX_IMAGE otherwise sees that field appear in
    // every `fields` assertion here, while CI (which has no .env) stays green.
    // A test whose subject is "exactly the documented variables, nothing else"
    // is only meaningful if the ambient environment cannot contribute.
    for (const key of [
      "ENABLE_MODAL_PROVISIONING",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "MODAL_APP_NAME",
      "NODE_AGENT_MODAL_IMAGE",
      "NODE_AGENT_MODAL_OPENCODE_IMAGE",
      "NODE_AGENT_MODAL_PI_IMAGE",
      "NODE_AGENT_FLY_IMAGE",
      "NODE_AGENT_FLY_OPENCODE_IMAGE",
      "NODE_AGENT_FLY_PI_IMAGE",
      "NODE_AGENT_IMAGE",
      "NODE_AGENT_OPENCODE_IMAGE",
      "NODE_AGENT_PI_IMAGE",
      "PROVISIONING_HUB_URL",
      "ENABLE_CLOUDFLARE_SANDBOXES",
      "CLOUDFLARE_SANDBOX_IMAGE",
      "ENABLE_FLY_PROVISIONING",
      "FLY_API_TOKEN",
      "FLY_VOLUME_SIZE_GB",
      "ENABLE_DOCKER_PROVISIONING",
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
    // --env-file=/dev/null stops bun auto-loading apps/hub/.env in the child.
    // cwd is hubRoot, so without this the developer's own .env is layered on
    // top of `env` INSIDE the child, after every delete above has happened —
    // scrubbing the parent environment cannot reach it. CI has no .env, so
    // this is also what makes a local run and a CI run the same run.
    const proc = Bun.spawnSync(["bun", "--env-file=/dev/null", "-e", script], {
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

  it("REFUSES a Modal hub that set only the generic image (issue #283)", () => {
    // The variables below are exactly what DEPLOYMENT.md used to ask for, and
    // they produced a hub that booted and then answered 502 for the two
    // harnesses the console offers. Driven through real env parsing because the
    // subject is the VARIABLE NAMES: a rule that reported a name the resolver
    // does not read would send an operator to set something with no effect.
    const result = collectInChild({
      ENABLE_MODAL_PROVISIONING: "true",
      MODAL_TOKEN_ID: "ak-live-id",
      MODAL_TOKEN_SECRET: "as-live-secret",
      NODE_AGENT_MODAL_IMAGE: "ghcr.io/example/agentpod-node-modal:v1",
      PROVISIONING_HUB_URL: "https://hub.example",
    });
    expect(result.fields).toEqual([
      "NODE_AGENT_MODAL_OPENCODE_IMAGE",
      "NODE_AGENT_MODAL_PI_IMAGE",
    ]);
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
      NODE_AGENT_MODAL_OPENCODE_IMAGE:
        "ghcr.io/example/agentpod-node-modal-opencode:v1",
      NODE_AGENT_MODAL_PI_IMAGE: "ghcr.io/example/agentpod-node-modal-pi:v1",
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

// ─── Fly ──────────────────────────────────────────────────────────────────────

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

// ─── Per-harness images on the substrates that PULL them ─────────────────────

/**
 * The gap issue #283 was found through: a hub with Modal enabled and only
 * `NODE_AGENT_MODAL_IMAGE` set boots cleanly, offers OpenCode and Pi in the New
 * Runtime dialog (the console offers all three harnesses for every provider),
 * and then answers 502 the moment anyone picks one — because
 * `imageForHarness("opencode", "modal")` falls through to the local Docker tag
 * and the driver refuses it as "not a registry reference Modal can pull".
 *
 * WHY THE RESOLVED IMAGE, NOT THE PRESENCE OF A VARIABLE. The rule asks the
 * SAME function the provisioner asks. An operator who points the un-scoped
 * `NODE_AGENT_PI_IMAGE` at a registry reference has genuinely configured Pi
 * everywhere, and a check that demanded the provider-scoped name would refuse a
 * working hub — while a check that merely counted variables would pass a hub
 * whose variable holds `agentpod-node-pi:local`.
 *
 * WHY MODAL REFUSES THE BOOT AND FLY ONLY REPORTS. Not squeamishness: after
 * this change every advertised harness HAS a published Modal image
 * (agentpod-node-modal, -modal-opencode, -modal-pi), so demanding all three
 * costs a Modal operator three lines they can actually satisfy. Fly has no
 * generic (harness-less) image published at all, so a fatal rule there would
 * make `ENABLE_FLY_PROVISIONING=true` unbootable no matter what the operator
 * did — turning a substrate that serves OpenCode and Pi perfectly well into a
 * hub that will not start. When a Fly generic image exists, this becomes fatal
 * for Fly too, and the test below is where that change gets recorded.
 */
describe("validateConfig — per-harness images on registry-pulling providers", () => {
  const LOCAL_DEFAULTS: Record<string, string> = {
    none: "agentpod-node:local",
    opencode: "agentpod-node-opencode:local",
    pi: "agentpod-node-pi:local",
  };

  /**
   * A stand-in for imageForHarness keyed `"<provider>:<harness>"`, falling back
   * to the same local defaults production falls back to. Injected rather than
   * driven through process.env so these tests cannot be broken by a developer's
   * apps/hub/.env — the real variable NAMES are covered in the child-process
   * tests further down, which is the only place they can be.
   */
  const resolving =
    (images: Record<string, string>) => (harness: string, provider: string) =>
      images[`${provider}:${harness}`] ?? LOCAL_DEFAULTS[harness] ?? "agentpod-node:local";

  /**
   * Image errors only. The built-in ENCRYPTION_KEY default is 33 characters and
   * is therefore always an error in a hand-built config — a pre-existing quirk
   * (see collectInChild above) that has nothing to do with images and would
   * otherwise sit in every assertion here.
   */
  const errorsWith = (cfg: typeof config, images: Record<string, string>) =>
    collectConfigErrors(cfg, quiet, resolving(images)).filter((e) =>
      e.field.startsWith("NODE_AGENT_")
    );

  const warningsWith = (cfg: typeof config, images: Record<string, string>) => {
    const warnings: string[] = [];
    collectConfigErrors(cfg, (m) => warnings.push(m), resolving(images));
    return warnings;
  };

  const modalHub = (over: Partial<typeof config.modal> = {}) =>
    ({
      ...config,
      modal: {
        ...config.modal,
        enabled: true,
        tokenId: "tok-id",
        tokenSecret: "tok-secret",
        image: "ghcr.io/example/agentpod-node-modal:v1",
        ...over,
      },
      provisioningHubUrl: "https://hub.example",
    }) as typeof config;

  const flyHub = (over: Partial<typeof config.fly> = {}) =>
    ({
      ...config,
      fly: { ...config.fly, enabled: true, apiToken: "fly-token", volumeSizeGb: 3, ...over },
    }) as typeof config;

  const MODAL_IMAGES = {
    "modal:none": "ghcr.io/example/agentpod-node-modal:v1",
    "modal:opencode": "ghcr.io/example/agentpod-node-modal-opencode:v1",
    "modal:pi": "ghcr.io/example/agentpod-node-modal-pi:v1",
  };

  it("REFUSES a Modal hub that cannot serve a harness the console offers", () => {
    // Exactly the live failure in #283: the generic image is set, the other two
    // are not, and nothing said so until a user clicked Create.
    const fields = errorsWith(modalHub(), {
      "modal:none": "ghcr.io/example/agentpod-node-modal:v1",
    }).map((e) => e.field);
    expect(fields).toContain("NODE_AGENT_MODAL_OPENCODE_IMAGE");
    expect(fields).toContain("NODE_AGENT_MODAL_PI_IMAGE");
  });

  it("names the harness, the substrate and the variable that closes the gap", () => {
    // A boot refusal is only worth having if the operator can act on it without
    // reading the source.
    const error = errorsWith(modalHub(), {}).find(
      (e) => e.field === "NODE_AGENT_MODAL_PI_IMAGE"
    )!;
    expect(error.message).toMatch(/pi/);
    expect(error.message).toMatch(/ENABLE_MODAL_PROVISIONING/);
    expect(error.message).toMatch(/agentpod-node-pi:local/);
  });

  it("accepts a Modal hub with every advertised harness pointed at a registry", () => {
    const fields = errorsWith(modalHub(), MODAL_IMAGES).map((e) => e.field);
    expect(fields).not.toContain("NODE_AGENT_MODAL_OPENCODE_IMAGE");
    expect(fields).not.toContain("NODE_AGENT_MODAL_PI_IMAGE");
  });

  it("accepts an un-scoped variable that is itself a registry reference", () => {
    // NODE_AGENT_OPENCODE_IMAGE=ghcr.io/... serves Docker and Modal at once —
    // documented, legitimate, and invisible to a rule that counted variables
    // instead of asking what the provisioner would actually be handed.
    const fields = errorsWith(modalHub(), {
      ...MODAL_IMAGES,
      "modal:opencode": "ghcr.io/example/shared-opencode:v1",
    }).map((e) => e.field);
    expect(fields).not.toContain("NODE_AGENT_MODAL_OPENCODE_IMAGE");
  });

  it("says nothing about harness images when Modal is disabled", () => {
    // Every deployment today. A hub that never registers the driver must not be
    // stopped from booting by that driver's variables.
    const fields = errorsWith(modalHub({ enabled: false }), {}).map((e) => e.field);
    expect(fields).not.toContain("NODE_AGENT_MODAL_OPENCODE_IMAGE");
    expect(fields).not.toContain("NODE_AGENT_MODAL_PI_IMAGE");
  });

  it("REPORTS a Fly harness with no registry image, without refusing the boot", () => {
    const cfg = flyHub();
    const images = { "fly:opencode": "ghcr.io/example/agentpod-node-opencode-fly:v1" };
    const warnings = warningsWith(cfg, images).join("\n");
    // Pi and the generic image are unconfigured, so both are named...
    expect(warnings).toMatch(/NODE_AGENT_FLY_PI_IMAGE/);
    expect(warnings).toMatch(/NODE_AGENT_FLY_IMAGE/);
    // ...the one that IS configured is not...
    expect(warnings).not.toMatch(/NODE_AGENT_FLY_OPENCODE_IMAGE/);
    // ...and the hub still boots, which is the whole difference from Modal.
    expect(errorsWith(cfg, images).map((e) => e.field)).toEqual([]);
  });

  it("says nothing about Fly harness images when Fly is off", () => {
    expect(warningsWith(flyHub({ enabled: false }), {}).join("\n")).not.toMatch(
      /NODE_AGENT_FLY/
    );
  });

  it("reports nothing when every Fly harness resolves to a registry image", () => {
    const warnings = warningsWith(flyHub(), {
      "fly:none": "ghcr.io/example/agentpod-node-fly:v1",
      "fly:opencode": "ghcr.io/example/agentpod-node-opencode-fly:v1",
      "fly:pi": "ghcr.io/example/agentpod-node-pi-fly:v1",
    }).join("\n");
    expect(warnings).not.toMatch(/NODE_AGENT_FLY/);
  });

  it("leaves the live hub — docker + cloudflare, local tags everywhere — alone", () => {
    // The rule is about substrates that PULL. Docker's images come from the
    // host daemon and Cloudflare's is baked into the deployed worker
    // (imageBinding: "fixed", covered by CLOUDFLARE_SANDBOX_IMAGE), so a local
    // tag is correct for both and must never be reported here.
    const live = {
      ...config,
      cloudflare: {
        ...config.cloudflare,
        enabled: true,
        sandboxImage: "agentpod-node-opencode:local",
      },
      modal: { ...config.modal, enabled: false },
      fly: { ...config.fly, enabled: false },
    } as typeof config;
    expect(errorsWith(live, {}).map((e) => e.field)).toEqual([]);
    expect(warningsWith(live, {}).join("\n")).not.toMatch(/NODE_AGENT_/);
  });
});
