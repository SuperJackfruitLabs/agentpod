/**
 * System Settings Model
 * 
 * Manages global system configuration stored in the database.
 * Uses a key-value pattern for flexibility.
 */

import { db } from "../db/drizzle";
import { systemSettings } from "../db/schema/admin";
import { eq } from "drizzle-orm";
import { createLogger } from "../utils/logger";

const log = createLogger("system-settings");

// =============================================================================
// Setting Keys
// =============================================================================

export const SETTING_KEYS = {
  /** Whether public signup is enabled (first user disables it) */
  SIGNUP_ENABLED: "signup_enabled",
} as const;

export type SettingKey = typeof SETTING_KEYS[keyof typeof SETTING_KEYS];

// =============================================================================
// Default Values
// =============================================================================

const DEFAULT_VALUES: Record<SettingKey, string> = {
  [SETTING_KEYS.SIGNUP_ENABLED]: "true",
};

// =============================================================================
// Functions
// =============================================================================

/**
 * Get a setting value by key
 */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const result = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, key))
    .limit(1);
  
  if (result.length === 0) {
    // Return default value if not set
    return DEFAULT_VALUES[key] ?? null;
  }
  
  return result[0]!.value;
}

/**
 * Get a setting value as boolean
 */
export async function getSettingBool(key: SettingKey): Promise<boolean> {
  const value = await getSetting(key);
  return value === "true";
}

/**
 * Set a setting value
 */
export async function setSetting(
  key: SettingKey, 
  value: string, 
  updatedBy?: string,
  description?: string
): Promise<void> {
  await db
    .insert(systemSettings)
    .values({
      key,
      value,
      description,
      updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value,
        updatedBy,
        updatedAt: new Date(),
      },
    });
  
  log.info("Setting updated", { key, value, updatedBy });
}

/**
 * Check if signup is enabled
 */
export async function isSignupEnabled(): Promise<boolean> {
  return getSettingBool(SETTING_KEYS.SIGNUP_ENABLED);
}

/**
 * Disable signup (called after first user is created)
 */
export async function disableSignup(updatedBy?: string): Promise<void> {
  await setSetting(
    SETTING_KEYS.SIGNUP_ENABLED, 
    "false", 
    updatedBy,
    "Public signup disabled after first user creation"
  );
  log.info("Public signup disabled", { updatedBy });
}

/**
 * Enable signup (admin action)
 */
export async function enableSignup(updatedBy: string): Promise<void> {
  await setSetting(
    SETTING_KEYS.SIGNUP_ENABLED, 
    "true", 
    updatedBy,
    "Public signup enabled by admin"
  );
  log.info("Public signup enabled", { updatedBy });
}

/**
 * Settings that are not dumped by `getAllSettings`: they carry a secret (an
 * encrypted API key), and have their own write-only endpoints instead.
 * `transcription` — see `services/transcription-settings.ts`.
 */
export const PRIVATE_SETTING_KEYS: ReadonlySet<string> = new Set(["transcription"]);

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<Record<string, { value: string; description?: string | null }>> {
  const results = await db.select().from(systemSettings);
  
  const settings: Record<string, { value: string; description?: string | null }> = {};
  
  // Add defaults first
  for (const [key, defaultValue] of Object.entries(DEFAULT_VALUES)) {
    settings[key] = { value: defaultValue };
  }
  
  // Override with actual values
  for (const row of results) {
    if (PRIVATE_SETTING_KEYS.has(row.key)) continue;
    settings[row.key] = { value: row.value, description: row.description };
  }
  
  return settings;
}
