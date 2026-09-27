/**
 * @deprecated This SQLite auth module is DEPRECATED.
 * Use drizzle-auth.ts with PostgreSQL for all environments.
 * This file is only kept for legacy test compatibility.
 * TODO: Migrate tests to use PostgreSQL auth configuration.
 */

import { betterAuth } from "better-auth";
import { bearer, admin } from "better-auth/plugins";
import { Database } from "bun:sqlite";
import { config } from "../config";
import { createLogger } from "../utils/logger";

const log = createLogger("auth");

// =============================================================================
// Database Setup
// =============================================================================

/**
 * Get the database connection for Better Auth
 * Uses Bun's built-in SQLite for development
 */
function getDatabase() {
  // Ensure the data directory exists
  const dbPath = config.database.path;
  log.info("Initializing auth database", { path: dbPath });

  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent access
  db.exec("PRAGMA journal_mode = WAL;");

  return db;
}

// =============================================================================
// Better Auth Instance
// =============================================================================

/**
 * Better Auth instance configured for AgentPod
 *
 * Authentication methods:
 * - GitHub OAuth (recommended)
 * - Email/Password (optional, disabled by default)
 *
 * Session:
 * - Cookie-based sessions
 * - 7 day expiry
 * - Auto-refresh on activity
 */
export const auth = betterAuth({
  // Database
  database: getDatabase(),

  // Base URL for callbacks
  baseURL: config.publicUrl,

  // App name for emails/display
  appName: "AgentPod",

  secret: config.betterAuth.session.secret,

  // ==========================================================================
  // Session Configuration
  // ==========================================================================
  session: {
    // Session cookie name
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes cache
    },
    // Session expiry
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    // Update session on activity
    updateAge: 60 * 60 * 24, // Update every 24 hours
  },

  // ==========================================================================
  // Email/Password Authentication
  // ==========================================================================
  emailAndPassword: {
    enabled: true,
    // Allow sign up with email/password
    disableSignUp: false,
    // Require email verification (disabled for development simplicity)
    requireEmailVerification: false,
    // Automatically sign in after sign up
    autoSignIn: true,
    // Password requirements
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },

  // ==========================================================================
  // Social Providers
  // ==========================================================================
  socialProviders: {
    // GitHub OAuth - Primary authentication method
    github: {
      clientId: config.betterAuth.github.clientId,
      clientSecret: config.betterAuth.github.clientSecret,
      // Request additional scopes for GitHub integration
      scope: ["read:user", "user:email"],
    },
  },

  // ==========================================================================
  // Trusted Origins (for CORS)
  // ==========================================================================
  trustedOrigins: [
    "http://localhost:5173",  // Vite dev
    config.publicUrl,         // API URL itself
  ],

  // ==========================================================================
  // Plugins
  // ==========================================================================
  plugins: [
    // Bearer token plugin - allows using session tokens as Bearer tokens
    // This is needed for Tauri/native apps that can't use cookies
    bearer(),
    
    // Admin plugin - enables user management, banning, role management
    admin({
      defaultRole: "user",
      adminRoles: ["admin"],
    }),
  ],
  
  // ==========================================================================
  // User Additional Fields
  // ==========================================================================
  user: {
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "user",
        input: false,
      },
      banned: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      bannedReason: {
        type: "string",
        required: false,
        input: false,
      },
      bannedAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },

  // ==========================================================================
  // Advanced Options
  // ==========================================================================
  advanced: {
    // Use secure cookies in production
    useSecureCookies: config.nodeEnv === "production",
    // Cookie prefix. The value is load-bearing and must not change: every live
    // session cookie carries it, so renaming it signs out every operator at once.
    // It was originally chosen to match a MetaMCP SSO integration that no longer
    // exists; the integration is gone, the prefix stays.
    cookiePrefix: "better-auth",
    // Generate unique session IDs
    generateId: () => crypto.randomUUID(),
  },

  // ==========================================================================
  // Callbacks
  // ==========================================================================

  // Log events for debugging
  logger: {
    disabled: config.nodeEnv === "production",
    level: "debug",
  },
});

// =============================================================================
// Type Exports
// =============================================================================

/**
 * Inferred types from Better Auth
 */
export type Session = typeof auth.$Infer.Session.session;
export type User = typeof auth.$Infer.Session.user;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Check if Better Auth is properly configured
 */
export function isAuthConfigured(): boolean {
  return !!(
    config.betterAuth.github.clientId &&
    config.betterAuth.github.clientSecret
  );
}

/**
 * Get the auth handler for mounting to Hono
 */
export function getAuthHandler() {
  return auth.handler;
}

log.info("Better Auth initialized", {
  baseURL: config.publicUrl,
  githubConfigured: !!config.betterAuth.github.clientId,
  environment: config.nodeEnv,
});
