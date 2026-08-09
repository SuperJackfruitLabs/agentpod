/**
 * Connection Store
 *
 * Manages the connection state to the Management API using Svelte 5 runes.
 * Uses fetch + localStorage (no Tauri) so it works in the browser/SPA build.
 */

import { setAuthApiUrl, clearAuthSession } from "./auth.svelte";
import { probeHealth, getStoredApiUrl, setStoredApiUrl, clearStoredApiUrl } from "$lib/api/connection-web";
import { startPolling } from "$lib/utils/poll";

// =============================================================================
// Types
// =============================================================================

export interface ConnectionStatus {
  connected: boolean;
  apiUrl: string | null;
  lastTested: string | null;
  error: string | null;
}

// =============================================================================
// State
// =============================================================================

let connectionStatus = $state<ConnectionStatus>({
  connected: false,
  apiUrl: null,
  lastTested: null,
  error: null,
});

let isLoading = $state(false);
let isInitialized = $state(false);

/**
 * Whether the hub answered the most recent periodic /health probe. Starts
 * true (optimistic until proven otherwise) and is only meaningful while
 * connected. Distinct from `connected`, which reflects the one-time
 * connect/boot handshake — this tracks reachability NOW, so the shell can
 * stop claiming "Connected" after the hub goes away mid-session.
 */
let reachable = $state(true);

// =============================================================================
// Derived State
// =============================================================================

export const connection = {
  get status() { return connectionStatus; },
  get isConnected() { return connectionStatus.connected; },
  get isLoading() { return isLoading; },
  get isInitialized() { return isInitialized; },
  get apiUrl() { return connectionStatus.apiUrl; },
  get error() { return connectionStatus.error; },
  get reachable() { return reachable; },
};

// =============================================================================
// Actions
// =============================================================================

/**
 * Connect to a Management API instance.
 *
 * Probes GET /health; on success persists the URL to localStorage and updates
 * the auth client via setAuthApiUrl.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function connect(apiUrl: string, _apiKey?: string): Promise<boolean> {
  isLoading = true;
  try {
    const ok = await probeHealth(apiUrl);

    if (ok) {
      const normalised = apiUrl.replace(/\/$/, "");
      connectionStatus = {
        connected: true,
        apiUrl: normalised,
        lastTested: new Date().toISOString(),
        error: null,
      };
      setStoredApiUrl(normalised);
      setAuthApiUrl(normalised);
      reachable = true;
      return true;
    } else {
      connectionStatus = {
        connected: false,
        apiUrl,
        lastTested: new Date().toISOString(),
        error: "Couldn’t reach the hub.",
      };
      return false;
    }
  } catch (error) {
    connectionStatus = {
      connected: false,
      apiUrl,
      lastTested: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Connection failed",
    };
    return false;
  } finally {
    isLoading = false;
  }
}

/**
 * Restore connection from localStorage.
 *
 * Idempotent — safe to call multiple times. Re-probes /health whenever
 * called so the UI always reflects the current reachability of the hub.
 * If already connected and isInitialized, this is a no-op.
 */
export async function initConnection(): Promise<void> {
  if (isInitialized && connectionStatus.connected) return;

  // Fall back to the build-time PUBLIC_HUB_URL so a hosted deployment (empty
  // localStorage on first visit) auto-connects and configures the auth client.
  // Without this the auth client never gets a base URL, initAuth() bails, and
  // the login guard can't run — an anonymous visitor sees the shell + 401s
  // instead of being redirected to /login. Mirrors api/client's fallback.
  const storedUrl = getStoredApiUrl() ?? import.meta.env.PUBLIC_HUB_URL ?? null;
  if (!storedUrl) {
    isInitialized = true;
    return;
  }

  isLoading = true;
  try {
    const ok = await probeHealth(storedUrl);

    if (ok) {
      const normalised = storedUrl.replace(/\/$/, "");
      connectionStatus = {
        connected: true,
        apiUrl: normalised,
        lastTested: new Date().toISOString(),
        error: null,
      };
      setAuthApiUrl(normalised);
    }
    // On failure: leave disconnected; keep the stored URL so the connect
    // screen can prefill the last-used address.
  } catch {
    // Network error — stay disconnected, URL remains in localStorage.
  } finally {
    isLoading = false;
    isInitialized = true;
  }
}

/**
 * Disconnect from the Management API.
 *
 * Clears the persisted URL and resets all state so initConnection can be
 * called again (important for test isolation).
 */
export async function disconnect(): Promise<void> {
  clearStoredApiUrl();
  connectionStatus = {
    connected: false,
    apiUrl: null,
    lastTested: null,
    error: null,
  };
  isInitialized = false;
  isLoading = false;
  reachable = true;
  // Also clear auth so a previous hub's identity doesn't persist on switch.
  clearAuthSession();
}

/**
 * Periodically re-probe /health so `connection.reachable` reflects the hub's
 * CURRENT reachability instead of the boot-time snapshot. Visibility-aware
 * (skips hidden tabs, probes immediately on tab return). Returns a stop
 * function for layout cleanup.
 */
export function startReachabilityProbe(intervalMs = 30_000): () => void {
  const probe = async () => {
    if (!connectionStatus.connected || !connectionStatus.apiUrl) return;
    try {
      reachable = await probeHealth(connectionStatus.apiUrl);
    } catch {
      reachable = false;
    }
    connectionStatus.lastTested = new Date().toISOString();
  };
  return startPolling(() => void probe(), intervalMs);
}

/**
 * Test the current connection (compatibility shim).
 */
export async function testConnection(): Promise<boolean> {
  if (!connectionStatus.apiUrl) return false;
  return connect(connectionStatus.apiUrl);
}
