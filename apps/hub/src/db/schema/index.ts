/**
 * Drizzle ORM Schema - Main Export
 *
 * Re-exports all schema modules for use with Drizzle.
 * Each module defines tables for a specific domain.
 */

// Tenants — the local isolation boundary every scoped table hangs off.
// First, because everything below references it.
export * from "./tenants";

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

// Work claimed from an external orchestrator (the kaambaan bridge)
export * from "./bridge";

export * from "./identities";

export * from "./grants";

// Matrix Application Service bookkeeping (#351)
export * from "./matrix";
