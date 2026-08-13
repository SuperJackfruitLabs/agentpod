/**
 * Unit tests: provider-scoped image resolution.
 *
 * Image resolution is service-layer work: drivers are image-agnostic and always
 * use ProvisionSpec.image. It becomes provider-aware here because two enabled
 * substrates need different references for the SAME harness — Docker a local
 * tag from the host daemon, Modal a registry reference it can pull. One
 * variable cannot serve both, and the failure mode when it tries is silent: the
 * sandbox never boots, the runtime sits in `provisioning`, and the sweeper
 * names nothing useful two minutes later.
 *
 * The live hub runs `docker, cloudflare` and must be completely unaffected.
 * That claim is checked twice, deliberately:
 *   - in-process, against `process.env`, which is what imageForHarness reads;
 *   - in a CHILD PROCESS carrying the exact variables docs/DEPLOYMENT.md tells
 *     an operator to set, which is the only way to cover the variable NAMES.
 *     A hand-driven test cannot see a resolver that reads the wrong env key,
 *     because it sets whatever key the implementation happens to read.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";

import { describe, it, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { imageForHarness } from "./runtimes";

const KEYS = [
  "NODE_AGENT_IMAGE",
  "NODE_AGENT_OPENCODE_IMAGE",
  "NODE_AGENT_PI_IMAGE",
  "NODE_AGENT_MODAL_IMAGE",
  "NODE_AGENT_MODAL_OPENCODE_IMAGE",
  "NODE_AGENT_MODAL_PI_IMAGE",
  "NODE_AGENT_DOCKER_IMAGE",
];

/**
 * `bun test` runs every file in ONE process, so an env var this file sets is an
 * env var the next file inherits. Restore rather than delete: a deployment (or
 * a developer's apps/hub/.env) may legitimately have set these before the run.
 */
const ORIGINAL = new Map(KEYS.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of ORIGINAL) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("imageForHarness", () => {
  it("keeps today's behaviour for a provider with no override", () => {
    // The regression guard: Docker and Cloudflare must resolve exactly what
    // they resolved before this change.
    expect(imageForHarness("none", "docker")).toBe("agentpod-node:local");
    expect(imageForHarness("opencode", "docker")).toBe("agentpod-node-opencode:local");
    expect(imageForHarness("pi", "docker")).toBe("agentpod-node-pi:local");
    expect(imageForHarness("none", "cloudflare")).toBe("agentpod-node:local");
    expect(imageForHarness("opencode", "cloudflare")).toBe("agentpod-node-opencode:local");

    process.env.NODE_AGENT_IMAGE = "custom:tag";
    process.env.NODE_AGENT_OPENCODE_IMAGE = "custom-oc:tag";
    expect(imageForHarness("none", "docker")).toBe("custom:tag");
    expect(imageForHarness("opencode", "docker")).toBe("custom-oc:tag");
    expect(imageForHarness("none", "cloudflare")).toBe("custom:tag");
  });

  it("prefers a provider-scoped override", () => {
    process.env.NODE_AGENT_IMAGE = "agentpod-node:local";
    process.env.NODE_AGENT_MODAL_IMAGE = "ghcr.io/example/agentpod-node-modal:v1";
    expect(imageForHarness("none", "modal")).toBe("ghcr.io/example/agentpod-node-modal:v1");
    expect(imageForHarness("none", "docker")).toBe("agentpod-node:local");
  });

  it("gives one provider's override to that provider ONLY", () => {
    // The point of the whole change. A scope that leaked would hand Docker a
    // registry reference it has no local tag for — or, the other way round,
    // hand Modal the local tag that made this task necessary.
    process.env.NODE_AGENT_MODAL_IMAGE = "ghcr.io/example/agentpod-node-modal:v1";
    process.env.NODE_AGENT_MODAL_OPENCODE_IMAGE = "ghcr.io/example/modal-oc:v1";
    expect(imageForHarness("none", "docker")).toBe("agentpod-node:local");
    expect(imageForHarness("opencode", "docker")).toBe("agentpod-node-opencode:local");
    expect(imageForHarness("none", "cloudflare")).toBe("agentpod-node:local");
    expect(imageForHarness("opencode", "cloudflare")).toBe("agentpod-node-opencode:local");
    // ...and a provider nobody has written a variable for is untouched too.
    expect(imageForHarness("none", "fly")).toBe("agentpod-node:local");
  });

  it("scopes per harness as well as per provider", () => {
    process.env.NODE_AGENT_MODAL_IMAGE = "ghcr.io/example/agentpod-node-modal:v1";
    process.env.NODE_AGENT_MODAL_OPENCODE_IMAGE = "ghcr.io/example/agentpod-node-modal-oc:v1";
    process.env.NODE_AGENT_MODAL_PI_IMAGE = "ghcr.io/example/agentpod-node-modal-pi:v1";
    expect(imageForHarness("opencode", "modal")).toBe(
      "ghcr.io/example/agentpod-node-modal-oc:v1"
    );
    expect(imageForHarness("pi", "modal")).toBe("ghcr.io/example/agentpod-node-modal-pi:v1");
    // The harness-less scope must not answer for a harness that has its own.
    expect(imageForHarness("none", "modal")).toBe("ghcr.io/example/agentpod-node-modal:v1");
  });

  it("falls back to the harness-wide value when the provider has no override", () => {
    process.env.NODE_AGENT_OPENCODE_IMAGE = "agentpod-node-opencode:local";
    expect(imageForHarness("opencode", "modal")).toBe("agentpod-node-opencode:local");
  });

  it("ignores an empty provider-scoped variable rather than provisioning nothing", () => {
    // An operator who unsets a variable by emptying it means "I have not set
    // this". Treating "" as a hit would pass an empty image to a driver.
    process.env.NODE_AGENT_MODAL_IMAGE = "";
    process.env.NODE_AGENT_IMAGE = "agentpod-node:local";
    expect(imageForHarness("none", "modal")).toBe("agentpod-node:local");
  });
});

// ─── Variable names, through real env parsing ────────────────────────────────

/**
 * Everything above drives `process.env` in this process, which covers the
 * resolution ORDER but not the variable NAMES: the test sets whatever key the
 * implementation reads, so a resolver reading `NODE_AGENT_IMAGE` where
 * DEPLOYMENT.md says `NODE_AGENT_MODAL_IMAGE` would pass every one of them
 * while refusing an operator who followed the docs. These load the real modules
 * in a CHILD PROCESS under a controlled environment — the only way to observe
 * module-scope env parsing from a suite that shares one module registry — and
 * they name the variables the way the docs do, not the way the code does.
 */
const resolveInChild = (
  overrides: Record<string, string | null>,
  queries: Array<[harness: string, provider: string]>
) => {
  const hubRoot = join(import.meta.dir, "..", "..");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Every image and Modal variable starts UNSET, so a test that wants one says
  // so — including any inherited from the developer's own apps/hub/.env.
  for (const key of [
    ...KEYS,
    "ENABLE_MODAL_PROVISIONING",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "MODAL_APP_NAME",
    "PROVISIONING_HUB_URL",
  ]) {
    delete env[key];
  }
  env.NODE_ENV = "development";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }

  const script = `
    const { imageForHarness } = await import(${JSON.stringify(
      join(hubRoot, "src", "services", "runtimes.ts")
    )});
    const { config } = await import(${JSON.stringify(join(hubRoot, "src", "config.ts"))});
    const queries = ${JSON.stringify(queries)};
    console.log(JSON.stringify({
      images: Object.fromEntries(
        queries.map(([harness, provider]) => [
          harness + "@" + provider,
          imageForHarness(harness, provider),
        ])
      ),
      configModalImage: config.modal.image,
    }));
    process.exit(0);
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
    images: Record<string, string>;
    configModalImage: string;
  };
};

describe("imageForHarness — the documented variable names", () => {
  it("resolves the LIVE hub exactly as it resolves today", () => {
    // docs/DEPLOYMENT.md, verbatim: this is the deployment that must not move.
    // It has never heard of ENABLE_MODAL_PROVISIONING — a distinction invisible
    // to a test that passes `{ enabled: false }` by hand.
    const { images } = resolveInChild(
      {
        ENABLE_DOCKER_PROVISIONING: "true",
        ENABLE_CLOUDFLARE_SANDBOXES: "true",
        CLOUDFLARE_SANDBOX_IMAGE: "agentpod-node-opencode:local",
        NODE_AGENT_IMAGE: "agentpod-node:local",
        NODE_AGENT_OPENCODE_IMAGE: "agentpod-node-opencode:local",
        ENABLE_MODAL_PROVISIONING: null,
      },
      [
        ["none", "docker"],
        ["opencode", "docker"],
        ["pi", "docker"],
        ["none", "cloudflare"],
        ["opencode", "cloudflare"],
      ]
    );
    expect(images).toEqual({
      "none@docker": "agentpod-node:local",
      "opencode@docker": "agentpod-node-opencode:local",
      "pi@docker": "agentpod-node-pi:local",
      "none@cloudflare": "agentpod-node:local",
      "opencode@cloudflare": "agentpod-node-opencode:local",
    });
  });

  it("gives Modal the registry reference the operator set, and Docker its local tag", () => {
    // The hub this task exists for: both substrates enabled, one harness, two
    // references. NODE_AGENT_MODAL_IMAGE is the name config.ts validates at
    // boot, so it is the name the resolver has to read — a resolver reading
    // anything else boots clean and then hands Modal `agentpod-node:local`.
    const { images, configModalImage } = resolveInChild(
      {
        ENABLE_DOCKER_PROVISIONING: "true",
        ENABLE_MODAL_PROVISIONING: "true",
        MODAL_TOKEN_ID: "ak-live-id",
        MODAL_TOKEN_SECRET: "as-live-secret",
        PROVISIONING_HUB_URL: "https://hub.example",
        NODE_AGENT_IMAGE: "agentpod-node:local",
        NODE_AGENT_OPENCODE_IMAGE: "agentpod-node-opencode:local",
        NODE_AGENT_MODAL_IMAGE: "ghcr.io/example/agentpod-node-modal:v1",
      },
      [
        ["none", "modal"],
        ["opencode", "modal"],
        ["none", "docker"],
        ["opencode", "docker"],
      ]
    );
    expect(images["none@modal"]).toBe("ghcr.io/example/agentpod-node-modal:v1");
    expect(images["none@docker"]).toBe("agentpod-node:local");
    expect(images["opencode@docker"]).toBe("agentpod-node-opencode:local");
    // One variable, two readers: config.ts refuses to boot without it and the
    // resolver hands it to the driver. If those two ever name different
    // variables, the operator satisfies the boot check and Modal still gets a
    // tag it cannot pull.
    expect(configModalImage).toBe("ghcr.io/example/agentpod-node-modal:v1");
    expect(images["none@modal"]).toBe(configModalImage);
  });
});
