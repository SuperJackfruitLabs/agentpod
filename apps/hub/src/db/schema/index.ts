/**
 * Drizzle ORM Schema - Main Export
 *
 * Re-exports all schema modules for use with Drizzle.
 * Each module defines tables for a specific domain.
 */

// Tenants — the local isolation boundary every scoped table hangs off.
// First, because everything below references it.
export * from "./tenants";

// Organization plane — organizations and principals, living in the hub until
// the plane is extracted (see the module doc in ./organization).
export * from "./organization";

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

// The key this deployment signs service assertions with — kept apart from
// Better Auth's own `jwks` so the two authorities can be revoked separately
// (migration 0054).
export * from "./service-keys";

// A human's authorisation for a station to redeem its own Matrix credential.
export * from "./matrix-credentials";

// One-time authorization codes for the cross-domain token handoff — the only
// way a plane on its own domain can reach an issuer behind a SameSite=Lax
// cookie (docs/superpowers/specs/2026-09-02-cross-domain-token-handoff-design.md).
export * from "./oauth";
