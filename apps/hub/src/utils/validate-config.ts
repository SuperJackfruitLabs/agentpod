import { RuntimeHarness } from "@agentpod/contract";
import { config } from "../config";
import {
  harnessImageEnvVar,
  imageForHarness,
  isPullableFromRegistry,
  providerImageEnvVar,
} from "../services/runtimes-image";
import { resolveDockerDaemon } from "../services/provisioner/docker-daemon";

export interface ValidationError {
  field: string;
  message: string;
}

/** Where non-fatal advice goes. Injectable so tests are not noisy. */
type Warn = (message: string) => void;

/**
 * How the hub resolves a harness's image on a provider. Injectable for the same
 * reason `warn` is: the rules below must be exercisable against a config object
 * without a test's answers depending on the developer's own environment.
 * Production passes the real resolver — the SAME one createRuntime hands to the
 * driver, which is the entire point of checking it here.
 */
type ResolveImage = (harness: string, provider: string) => string;

/**
 * Substrates that PULL their images, and what a missing one costs there.
 *
 * Docker is absent because its images come from the daemon's own store, where a
 * local tag is exactly right — including on a REMOTE daemon, if the operator
 * built it there. That case is reported by the docker-daemon rule below, which
 * is where the "is this daemon somebody else's box?" answer lives; Docker does
 * not belong in this table because it never pulls at all. Cloudflare is absent
 * because its image is baked into
 * the deployed worker (`imageBinding: "fixed"`) and is covered by
 * CLOUDFLARE_SANDBOX_IMAGE above — a per-harness variable would be a fiction
 * there, since the driver refuses any image but the deployed one.
 *
 * `fatal` differs between the two, and not out of squeamishness:
 *
 *   Modal — every harness the console advertises has a published image
 *   (agentpod-node-modal, -modal-opencode, -modal-pi), so a Modal operator can
 *   satisfy this in three lines. Refusing the boot is what turns issue #283's
 *   failure ("502 The provisioning driver failed", discovered by a user
 *   clicking Create) into a sentence at startup naming the variable.
 *
 *   Fly — there is NO generic (harness-less) Fly image published. A fatal rule
 *   would therefore make ENABLE_FLY_PROVISIONING=true unbootable no matter what
 *   the operator did, taking down a substrate that serves OpenCode and Pi
 *   perfectly well. So Fly is reported at boot instead. When a generic Fly image
 *   exists, flip this to true — that is the whole change.
 */
const REGISTRY_PULLING_PROVIDERS: readonly {
  provider: string;
  flag: string;
  fatal: boolean;
  enabled: (cfg: typeof config) => boolean;
  /** Harnesses covered by a rule of their own, so they are not reported twice. */
  alreadyChecked: readonly string[];
}[] = [
  {
    provider: "modal",
    flag: "ENABLE_MODAL_PROVISIONING",
    fatal: true,
    enabled: (cfg) => cfg.modal.enabled,
    // NODE_AGENT_MODAL_IMAGE is a config field with its own rule above;
    // reporting the same variable twice would read as two separate problems.
    alreadyChecked: ["none"],
  },
  {
    provider: "fly",
    flag: "ENABLE_FLY_PROVISIONING",
    fatal: false,
    enabled: (cfg) => cfg.fly.enabled,
    // Fly has no image rule of its own, so its generic image is checked here or
    // nowhere.
    alreadyChecked: [],
  },
];

/**
 * Every harness the console offers for EVERY provider — the New Runtime dialog
 * lists all of them regardless of substrate, so every one of them is a promise
 * the hub has to keep. Read from the contract rather than copied, so adding a
 * harness to `RuntimeHarness` automatically extends this check instead of
 * silently adding a fourth way to answer 502.
 */
const ADVERTISED_HARNESSES: readonly string[] = RuntimeHarness.options;

/**
 * "The image this provider would actually be handed for this harness is a local
 * Docker tag, and this provider cannot pull those."
 *
 * The check asks the resolver, not the environment: an operator who points the
 * un-scoped NODE_AGENT_PI_IMAGE at a registry reference has configured Pi for
 * every provider, and demanding the provider-scoped variable on top would
 * refuse a hub that works.
 */
function harnessImageProblems(
  provider: string,
  flag: string,
  resolveImage: ResolveImage,
  skipHarnesses: readonly string[] = []
): ValidationError[] {
  const problems: ValidationError[] = [];
  for (const harness of ADVERTISED_HARNESSES) {
    if (skipHarnesses.includes(harness)) continue;
    const resolved = resolveImage(harness, provider);
    if (isPullableFromRegistry(resolved)) continue;
    problems.push({
      field: providerImageEnvVar(harness, provider),
      message:
        `The ${provider} substrate pulls its images from a registry, but the ` +
        `"${harness}" harness resolves to "${resolved}" — a tag that exists only in a ` +
        `local Docker daemon. The console offers every harness for every provider, so ` +
        `a runtime created with "${harness}" on ${provider} fails at provision time. ` +
        `Set ${providerImageEnvVar(harness, provider)} to a public registry reference, ` +
        `or point the un-scoped ${harnessImageEnvVar(harness)} at one. This substrate ` +
        `is enabled by ${flag}=true; unset it and nothing here applies. ` +
        `See docs/DEPLOYMENT.md.`,
    });
  }
  return problems;
}

function hasMinimumEntropy(value: string, minLength: number = 32): boolean {
  if (value.length < minLength) return false;
  
  const simplePatterns = [
    /^(.)\1+$/,
    /^(012|123|234|345|456|567|678|789|890)+$/,
    /^(abc|bcd|cde|def|efg|fgh|ghi|hij|ijk|jkl|klm|lmn|mno|nop|opq|pqr|qrs|rst|stu|tuv|uvw|vwx|wxy|xyz)+$/i,
  ];
  
  for (const pattern of simplePatterns) {
    if (pattern.test(value)) return false;
  }
  
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasNumber = /[0-9]/.test(value);
  const hasSpecial = /[^a-zA-Z0-9]/.test(value);
  
  const variety = [hasLower, hasUpper, hasNumber, hasSpecial].filter(Boolean).length;
  return variety >= 2;
}

/**
 * Every fatal configuration problem, as data.
 *
 * Split out of validateConfig so the rules can be exercised against a config
 * object in a test — validateConfig itself reads the process-wide singleton and
 * ends in process.exit(1), which is correct at boot and untestable anywhere else.
 */
export function collectConfigErrors(
  cfg: typeof config = config,
  warn: Warn = console.warn,
  resolveImage: ResolveImage = imageForHarness
): ValidationError[] {
  const errors: ValidationError[] = [];
  const isProduction = cfg.nodeEnv === "production";

  const devTokenPattern = /^dev-|change-in-production|example|test|dummy/i;
  if (devTokenPattern.test(cfg.auth.token)) {
    if (isProduction) {
      errors.push({
        field: "API_TOKEN",
        message: "Production API token cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      warn("⚠️  WARNING: Using development API token. Change before production!");
    }
  }

  if (devTokenPattern.test(cfg.betterAuth.session.secret)) {
    if (isProduction) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Production session secret cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      warn("⚠️  WARNING: Using development session secret. Change before production!");
    }
  }

  if (cfg.encryption.key.length !== 32) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: `Encryption key must be exactly 32 characters. Current length: ${cfg.encryption.key.length}`,
    });
  }
  
  if (devTokenPattern.test(cfg.encryption.key)) {
    if (isProduction) {
      errors.push({
        field: "ENCRYPTION_KEY",
        message: "Production encryption key cannot contain dev/test patterns.",
      });
    } else {
      warn("⚠️  WARNING: Using development encryption key. Change before production!");
    }
  }

  if (isProduction && !hasMinimumEntropy(cfg.encryption.key, 32)) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: "Encryption key has insufficient entropy. Use a cryptographically random value.",
    });
  }

  if (isProduction) {
    if (cfg.database.path.includes("agentpod-dev-password")) {
      errors.push({
        field: "DATABASE_URL",
        message: "Production database cannot use default dev password.",
      });
    }

    if (!cfg.traefik.tls) {
      warn("⚠️  WARNING: TLS is disabled. Enable for production deployment!");
    }

    if (!hasMinimumEntropy(cfg.betterAuth.session.secret, 32)) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Session secret has insufficient entropy. Generate with: openssl rand -base64 32",
      });
    }
  }

  // Conditional on purpose: required only where the Cloudflare driver is
  // actually registered. A Docker-only hub must not be stopped from booting by
  // a variable for a substrate it never talks to.
  //
  // Where it IS registered, the driver declares `imageBinding: "fixed"` — a
  // promise that it runs the image the worker was deployed with and refuses any
  // other. It can only keep that promise if it knows which image that is; with
  // CLOUDFLARE_SANDBOX_IMAGE unset it declares "fixed" and then honours
  // whatever spec it is handed, which is the incident the declaration was added
  // to prevent. Documented in cloudflare/worker-v2/README.md and set on the
  // live hub, but until now nothing checked, so a fresh deploy would silently
  // lack it.
  if (cfg.cloudflare.enabled && !cfg.cloudflare.sandboxImage) {
    errors.push({
      field: "CLOUDFLARE_SANDBOX_IMAGE",
      message:
        "Required when ENABLE_CLOUDFLARE_SANDBOXES=true: the image the worker was " +
        "deployed with (e.g. agentpod-node-opencode:local). Without it the Cloudflare " +
        "driver declares a fixed image and then provisions whatever it is asked for. " +
        "See cloudflare/worker-v2/README.md.",
    });
  }

  // Conditional for the same reason as the Cloudflare rule above: a hub that
  // never talks to Modal must not be stopped from booting by Modal's variables.
  // The live hub runs `docker, cloudflare` and has never heard of
  // ENABLE_MODAL_PROVISIONING; unset must stay indistinguishable from off.
  //
  // Why refuse to boot at all, when two of these already fail elsewhere? The
  // death is not new — createModalApi() calls requireCredentials() during
  // registration, so a hub with the flag on and no tokens already dies at
  // startup, just with an uncaught stack trace instead of a sentence naming the
  // variable. validateConfig() runs first (src/index.ts) and swaps one for the
  // other. The other two variables are why this is more than cosmetic:
  // NODE_AGENT_MODAL_IMAGE and PROVISIONING_HUB_URL do not fail at boot at all.
  // They fail silently, later, on somebody else's runtime.
  if (cfg.modal.enabled) {
    if (!cfg.modal.tokenId) {
      errors.push({
        field: "MODAL_TOKEN_ID",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true. Create it in the Modal " +
          "dashboard. Note: on Modal's Starter plan a token is WORKSPACE-WIDE — " +
          "per-resource scoping needs the $250/mo Team plan — so use a workspace " +
          "dedicated to AgentPod.",
      });
    }
    // Reported separately from the id, not as one "credentials are missing"
    // error: half-configured is the deploy an operator actually produces, and a
    // combined message would send them to re-check the half that was right.
    if (!cfg.modal.tokenSecret) {
      errors.push({
        field: "MODAL_TOKEN_SECRET",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true, alongside MODAL_TOKEN_ID.",
      });
    }
    if (!cfg.modal.image || !cfg.modal.image.includes("/")) {
      errors.push({
        field: "NODE_AGENT_MODAL_IMAGE",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true, and it must be a registry " +
          "reference Modal can pull (linux/amd64, carrying python and pip). The " +
          "Docker default `agentpod-node:local` is meaningless to Modal: the sandbox " +
          "never boots and the runtime sits in `provisioning` until it is expired. " +
          "See docs/DEPLOYMENT.md.",
      });
    }
    if (!cfg.provisioningHubUrl) {
      errors.push({
        field: "PROVISIONING_HUB_URL",
        message:
          "Required when ENABLE_MODAL_PROVISIONING=true: Modal destroys a sandbox at " +
          "24 hours, so the hub re-creates it on a timer with no request to take an " +
          "origin from. Unset, every rotation fails a day after anyone was watching.",
      });
    }
  }

  // Conditional for the same reason as CLOUDFLARE_SANDBOX_IMAGE above: required
  // only where the Fly driver is actually registered.
  //
  // This is the FRONT LINE of a refusal that already exists. bootstrap.ts
  // constructs FlyMachinesProvisioner when the flag is on, and that constructor
  // resolves FLY_API_TOKEN through requireCredentials, which throws. So a
  // tokenless Fly deployment cannot boot either way; the only question is
  // whether the operator gets a stack trace out of registerEnabledProvisioners
  // or this. A hub with the flag off — every deployment today — reaches neither.
  if (cfg.fly.enabled && !cfg.fly.apiToken) {
    errors.push({
      field: "FLY_API_TOKEN",
      message:
        "Required when ENABLE_FLY_PROVISIONING=true. Generate with `flyctl tokens create org <org>` " +
        "(app-scoped deploy tokens cannot CREATE apps, and this driver creates one per runtime). " +
        "Set the expiry explicitly — Fly defaults it to twenty years.",
    });
  }

  // Fly's minimum volume is 1 GB, and the volume is where the workspace lives:
  // this substrate wipes the rootfs on every stop→start, so a machine whose
  // mount failed loses a user's work exactly the way Cloudflare did.
  if (cfg.fly.enabled && cfg.fly.volumeSizeGb < 1) {
    errors.push({
      field: "FLY_VOLUME_SIZE_GB",
      message:
        `Must be at least 1 (got ${cfg.fly.volumeSizeGb}). The workspace lives on this volume ` +
        "because the Fly rootfs does not survive a stop.",
    });
  }

  // ── Which Docker daemon, and what reaching it costs ────────────────────────
  //
  // Conditional on ENABLE_DOCKER_PROVISIONING for the same reason every rule
  // above is conditional on its own flag.
  //
  // The refusals live in resolveDockerDaemon (services/provisioner/docker-daemon.ts)
  // next to the transport decisions they enforce, and the DRIVER applies the
  // identical rules when it constructs — this is the front line, not a second
  // opinion. What is at stake is not a typo: DOCKER_HOST decides which machine
  // receives root-equivalent container access from this hub, and a
  // half-configured remote daemon fails by silently using the local socket,
  // which looks exactly like success.
  if (cfg.docker.enabled) {
    const { connection, problems, warnings } = resolveDockerDaemon(cfg.docker);
    errors.push(...problems);
    for (const warning of warnings) warn(`⚠️  WARNING: ${warning}`);

    // A remote daemon has its own image store, and THE HUB NEVER PULLS —
    // createContainer runs what the daemon already holds. `agentpod-node:local`
    // is a tag on the hub's box and nothing on anyone else's, which is issue
    // #283's failure exactly, one substrate over: a clean boot, a full New
    // Runtime dialog, and a 404 the first time somebody picks a harness.
    //
    // Reported, not refused, and the difference is real: an operator who ran
    // `docker build -t agentpod-node:local` ON THE REMOTE HOST has a working
    // hub, and a fatal rule would refuse to boot it. Nothing the hub can see
    // distinguishes the two — only the remote daemon knows — so this says what
    // is suspicious and leaves the judgement where the knowledge is.
    if (connection?.remote) {
      for (const harness of ADVERTISED_HARNESSES) {
        const resolved = resolveImage(harness, "docker");
        if (isPullableFromRegistry(resolved)) continue;
        warn(
          `⚠️  WARNING: ${providerImageEnvVar(harness, "docker")}: DOCKER_HOST points at ` +
            `${connection.describe}, a daemon on another machine, and the "${harness}" ` +
            `harness resolves to "${resolved}" — a bare tag that exists only in a local ` +
            `image store. The hub never pulls; it creates containers from images the ` +
            `daemon already holds. Build or \`docker pull\` this tag ON THAT HOST, or set ` +
            `${providerImageEnvVar(harness, "docker")} to a registry reference and pull ` +
            `it there. See docs/DEPLOYMENT.md.`
        );
      }
    }
  }

  // ── Per-harness images on the substrates that pull them ────────────────────
  //
  // Issue #283: the hub checked NODE_AGENT_MODAL_IMAGE and nothing else, so a
  // Modal hub booted clean while being unable to serve either harness the
  // console offers. The generic image is a config-object value and is already
  // checked above; the per-harness variables are read by nothing except the
  // resolver, so this asks the resolver.
  for (const { provider, flag, fatal, enabled, alreadyChecked } of REGISTRY_PULLING_PROVIDERS) {
    if (!enabled(cfg)) continue;

    const problems = harnessImageProblems(provider, flag, resolveImage, alreadyChecked);

    if (fatal) {
      errors.push(...problems);
    } else {
      for (const problem of problems) {
        warn(`⚠️  WARNING: ${problem.field}: ${problem.message}`);
      }
    }
  }

  return errors;
}

export function validateConfig(): void {
  const errors = collectConfigErrors(config);

  if (errors.length > 0) {
    console.error("\n❌ CONFIGURATION VALIDATION FAILED\n");
    console.error("The following configuration errors must be fixed:\n");
    
    for (const error of errors) {
      console.error(`  • ${error.field}: ${error.message}`);
    }
    
    console.error("\n");
    console.error("Environment: " + config.nodeEnv);
    console.error("\nFor production deployment, ensure all secrets are properly configured.");
    console.error("See: docs/production-readiness/phase-1-security.md\n");
    
    process.exit(1);
  }

  console.log("✅ Configuration validation passed");
}
