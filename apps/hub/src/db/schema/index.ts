/**
 * Drizzle ORM Schema - Main Export
 *
 * Re-exports all schema modules for use with Drizzle.
 * Each module defines tables for a specific domain.
 */

// Authentication (Better Auth tables)
export * from "./auth";

// Admin (system settings, audit log)
export * from "./admin";

// Cloudflare sandbox integration
export * from "./cloudflare";

// Node registry (fleet console)
export * from "./nodes";

// Station registry (adopted stations, fleet console)
export * from "./stations";

// Station audit log (write ops + terminal events, fleet console)
export * from "./audit";

// ACP sessions + event log (fleet console)
export * from "./acp";
