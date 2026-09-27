/**
 * @agentpod/types - Shared TypeScript types for the Agentpod platform
 * 
 * This package provides type definitions shared across:
 * - apps/console (Tauri desktop app)
 * - apps/hub (Management API)
 * - Future: mobile apps, web client
 * 
 * Usage:
 *   import { Project, ProjectStatus } from "@agentpod/types";
 *   import type { Session, Message } from "@agentpod/types/opencode";
 */

// Project types
export * from "./project";

// Container tier types
export * from "./container";

// Provider/Model types
export * from "./provider";

// Settings types
export * from "./settings";

// OpenCode SDK re-exports
export * from "./opencode";

// API response types
export * from "./api";

// Onboarding system types
export * from "./onboarding";

// Admin types
export * from "./admin";

// Agent catalog types
export * from "./agents";

// Workflow builder types
export * from "./workflow";

// Session forking types
export * from "./session-fork";
