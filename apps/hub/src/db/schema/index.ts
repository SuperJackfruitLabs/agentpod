/**
 * Drizzle ORM Schema - Main Export
 *
 * Re-exports all schema modules for use with Drizzle.
 * Each module defines tables for a specific domain.
 */

// Tenants — the local isolation boundary every scoped table hangs off.
// First, because everything below references it.
export * from "./tenants";

// Principal kinds (the principals themselves live at the organization plane).
export * from "./organization";

// Admin (system settings, audit log)
export * from "./admin";

// Cloudflare sandbox integration
export * from "./cloudflare";

// Node registry (fleet console)
export * from "./nodes";

// Station registry (adopted stations, fleet console)
export * from "./stations";
export * from "./skills";

// Station audit log (write ops + terminal events, fleet console)
export * from "./audit";

// ACP sessions + event log (fleet console)
export * from "./acp";

// Work claimed from an external orchestrator (the superpipeline bridge)
export * from "./bridge";

// Matrix Application Service bookkeeping (#351)
export * from "./matrix";

// A human's authorisation for a station to redeem its own Matrix credential.
export * from "./matrix-credentials";

export * from "./station-setup";

// Voice-note transcription, per station (hub-wide lives in system_settings).
export * from "./transcription";

// Spoken replies, per station (hub-wide lives in system_settings).
export * from "./speech";

// Which key a station pushes with (forge today, per
// charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md).
export * from "./git-identities";
export * from "./board-rooms";

// Where the fleet Live Activity is pushed: a device's push-to-start token and
// each running activity's update token (supermessage spec 2026-09-29, A1).
export * from "./live-activity";

// What the fleet wants a harness setting to be, per station/node/fleet level.
// Never what a station HAS — that is read live from the node (declared
// harness config, observe arc, task 5).
export * from "./harness-config";

// What this system has actually written to a station (the journal of
// successful applies) and an operator's explicit opt-outs (task 7).
export * from "./harness-config-ops";

// Better Auth user id → prn_, frozen at the org-plane cutover; permanent (P3 plan, Task 9).
export * from "./legacy-user-principals";

// Who may operate this hub under the org plane, by principal id (P3 plan, Task 12; decision D4).
export * from "./operators";

// A person's Matrix id by principal, which the plane cannot answer in that direction (P3 plan, Task 17).
