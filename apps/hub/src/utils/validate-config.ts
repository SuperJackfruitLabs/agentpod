import { config } from "../config";

interface ValidationError {
  field: string;
  message: string;
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

export function validateConfig(): void {
  const errors: ValidationError[] = [];
  const isProduction = config.nodeEnv === "production";

  const devTokenPattern = /^dev-|change-in-production|example|test|dummy/i;
  if (devTokenPattern.test(config.auth.token)) {
    if (isProduction) {
      errors.push({
        field: "API_TOKEN",
        message: "Production API token cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      console.warn("⚠️  WARNING: Using development API token. Change before production!");
    }
  }

  if (devTokenPattern.test(config.betterAuth.session.secret)) {
    if (isProduction) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Production session secret cannot contain dev/test patterns. Generate with: openssl rand -base64 32",
      });
    } else {
      console.warn("⚠️  WARNING: Using development session secret. Change before production!");
    }
  }

  if (config.encryption.key.length !== 32) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: `Encryption key must be exactly 32 characters. Current length: ${config.encryption.key.length}`,
    });
  }
  
  if (devTokenPattern.test(config.encryption.key)) {
    if (isProduction) {
      errors.push({
        field: "ENCRYPTION_KEY",
        message: "Production encryption key cannot contain dev/test patterns.",
      });
    } else {
      console.warn("⚠️  WARNING: Using development encryption key. Change before production!");
    }
  }

  if (isProduction && !hasMinimumEntropy(config.encryption.key, 32)) {
    errors.push({
      field: "ENCRYPTION_KEY",
      message: "Encryption key has insufficient entropy. Use a cryptographically random value.",
    });
  }

  if (isProduction) {
    if (config.database.path.includes("agentpod-dev-password")) {
      errors.push({
        field: "DATABASE_URL",
        message: "Production database cannot use default dev password.",
      });
    }

    if (!config.traefik.tls) {
      console.warn("⚠️  WARNING: TLS is disabled. Enable for production deployment!");
    }

    if (!hasMinimumEntropy(config.betterAuth.session.secret, 32)) {
      errors.push({
        field: "BETTER_AUTH_SECRET",
        message: "Session secret has insufficient entropy. Generate with: openssl rand -base64 32",
      });
    }
  }

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
