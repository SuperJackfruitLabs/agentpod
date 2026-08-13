import { config } from "../config";

export interface ValidationError {
  field: string;
  message: string;
}

/** Where non-fatal advice goes. Injectable so tests are not noisy. */
type Warn = (message: string) => void;

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
  warn: Warn = console.warn
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
