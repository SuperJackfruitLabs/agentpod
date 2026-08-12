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
