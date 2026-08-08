/**
 * Auth Store
 *
 * Manages authentication state using Better Auth with Svelte 5 runes.
 * Replaces the previous Keycloak-based authentication.
 * 
 * The auth client is created dynamically based on the connected API URL.
 */

import { createAuthClient } from "better-auth/svelte";

// =============================================================================
// Dynamic Auth Client
// =============================================================================

// The auth client is created dynamically based on the connected API URL
let currentAuthClient: ReturnType<typeof createAuthClient> | null = null;
let currentApiUrl: string | null = null;

/**
 * Get the current auth client, or null if not yet configured.
 */
function getAuthClient(): ReturnType<typeof createAuthClient> | null {
  return currentAuthClient;
}

/**
 * Set the API URL and create a new auth client.
 * Called when connection is established (from the connection store).
 */
export function setAuthApiUrl(apiUrl: string) {
  currentApiUrl = apiUrl;
  currentAuthClient = createAuthClient({
    baseURL: apiUrl,
  });
}

/**
 * Get the current API URL
 */
export function getAuthApiUrl(): string | null {
  return currentApiUrl;
}

// =============================================================================
// State
// =============================================================================

let isLoading = $state(false);
let isInitialized = $state(false);
let error = $state<string | null>(null);
let sessionData = $state<{
  user: {
    id: string;
    email: string;
    name?: string | null;
    image?: string | null;
    /** Server-assigned role, e.g. "admin". Populated when the hub includes it in the session. */
    role?: string | null;
  };
} | null>(null);

// =============================================================================
// Derived State
// =============================================================================

export const auth = {
  // Convenience getters
  get isAuthenticated() {
    return !!sessionData?.user;
  },

  get user() {
    return sessionData?.user ?? null;
  },

  get isLoading() {
    return isLoading;
  },

  get isInitialized() {
    return isInitialized;
  },

  get error() {
    return error;
  },

  // Computed properties
  get displayName() {
    const user = sessionData?.user;
    if (!user) return null;
    return user.name || user.email || "User";
  },

  get initials() {
    const user = sessionData?.user;
    const name = user?.name || user?.email || null;
    if (!name) return "?";
    return name
      .split(" ")
      .map((n: string) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  },

  get avatarUrl() {
    return sessionData?.user?.image ?? null;
  },

  get email() {
    return sessionData?.user?.email ?? null;
  },
};

// =============================================================================
// Actions
// =============================================================================

/**
 * Initialize auth state by restoring the session via the Better Auth cookie.
 *
 * If the auth client has not been configured yet (setAuthApiUrl not called),
 * this is a no-op and isInitialized remains false — the caller MUST call
 * initAuth again once the connection (and therefore the auth client) is
 * established, at which point the session will be properly restored.
 *
 * Once a real attempt with a client completes (success OR a definitive
 * no-session result), isInitialized is set to true and subsequent calls
 * become no-ops.
 */
export async function initAuth(): Promise<void> {
  if (isInitialized) return;

  const client = getAuthClient();

  // No client yet (API URL not set) — leave isInitialized=false so a later
  // call after setAuthApiUrl() will proceed and restore the session.
  if (!client) {
    return;
  }

  isLoading = true;
  error = null;

  try {
    // Restore session from the HTTP-only cookie set by the hub
    const { data } = await client.getSession();
    if (data?.user) {
      sessionData = {
        user: {
          id: data.user.id,
          email: data.user.email,
          name: data.user.name ?? null,
          image: data.user.image ?? null,
          role: (data.user as { role?: string | null }).role ?? null,
        },
      };
    }
  } catch (err) {
    // Session fetch failed (network error, etc.) — stay unauthenticated but
    // surface the error so the UI can reflect the failed restore attempt.
    console.warn("[Auth] Failed to restore session:", err);
    error = err instanceof Error ? err.message : "Couldn’t restore your session.";
  } finally {
    isLoading = false;
    isInitialized = true;
  }
}

/**
 * Sign in with GitHub OAuth
 * Opens a popup or redirects to GitHub for authentication
 */
export async function login(): Promise<boolean> {
  isLoading = true;
  error = null;

  try {
    const client = getAuthClient();
    if (!client) {
      error = "Not connected to hub";
      return false;
    }
    const result = await client.signIn.social({
      provider: "github",
    });

    if (result.error) {
      error = result.error.message ?? "Sign in failed";
      return false;
    }

    return true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn’t start sign-in.";
    return false;
  } finally {
    isLoading = false;
  }
}

/**
 * Sign in with email and password
 */
export async function loginWithEmail(emailInput: string, password: string): Promise<boolean> {
  isLoading = true;
  error = null;

  try {
    const client = getAuthClient();
    if (!client) {
      error = "Not connected to hub";
      return false;
    }
    const result = await client.signIn.email({
      email: emailInput,
      password,
    });

    if (result.error) {
      error = result.error.message ?? "Sign in failed";
      return false;
    }

    // The hub sets an HTTP-only cookie — the cookie IS the session.
    // No bearer token storage needed.
    if (result.data?.user) {
      sessionData = {
        user: {
          id: result.data.user.id,
          email: result.data.user.email,
          name: result.data.user.name,
          image: result.data.user.image,
          role: (result.data.user as { role?: string | null }).role ?? null,
        },
      };
    }

    return true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn’t sign in.";
    return false;
  } finally {
    isLoading = false;
  }
}

/**
 * Sign up with email and password
 */
export async function signUp(emailInput: string, password: string, name: string): Promise<boolean> {
  isLoading = true;
  error = null;

  try {
    const client = getAuthClient();
    if (!client) {
      error = "Not connected to hub";
      return false;
    }
    const result = await client.signUp.email({
      email: emailInput,
      password,
      name,
    });

    if (result.error) {
      error = result.error.message ?? "Sign up failed";
      return false;
    }

    // The hub sets an HTTP-only cookie — the cookie IS the session.
    if (result.data?.user) {
      sessionData = {
        user: {
          id: result.data.user.id,
          email: result.data.user.email,
          name: result.data.user.name,
          image: result.data.user.image,
          role: (result.data.user as { role?: string | null }).role ?? null,
        },
      };
    }

    return true;
  } catch (err) {
    error = err instanceof Error ? err.message : "Couldn’t create the account.";
    return false;
  } finally {
    isLoading = false;
  }
}

/**
 * Logout the current user
 */
export async function logout(): Promise<void> {
  isLoading = true;
  error = null;

  try {
    const client = getAuthClient();
    if (client) {
      await client.signOut();
    }
    // Clear local session data regardless
    sessionData = null;
  } catch (err) {
    error = err instanceof Error ? err.message : "Logout failed";
  } finally {
    isLoading = false;
  }
}

/**
 * Refresh the session
 * Better Auth handles session refresh automatically
 */
export async function refreshToken(): Promise<boolean> {
  // Better Auth automatically manages session refresh
  // This is kept for API compatibility
  return auth.isAuthenticated;
}

/**
 * Get the current access token (for API calls)
 * With Better Auth, we use cookies, so this returns null
 * API calls should be made with credentials: 'include'
 */
export async function getToken(): Promise<string | null> {
  // Better Auth uses HTTP-only cookies, not bearer tokens
  // For API calls, use credentials: 'include' instead
  return null;
}

/**
 * Check authentication status
 */
export async function checkAuth(): Promise<boolean> {
  return auth.isAuthenticated;
}

/**
 * Clear any auth errors
 */
export function clearError(): void {
  error = null;
}

/**
 * Clear the auth session and reset the client.
 *
 * Called on disconnect / "use different server" so a previous hub's identity
 * and auth client don't persist when connecting to a different hub. Resets
 * isInitialized so a subsequent setAuthApiUrl() + initAuth() restores fresh.
 */
export function clearAuthSession(): void {
  sessionData = null;
  currentAuthClient = null;
  currentApiUrl = null;
  isInitialized = false;
  error = null;
}

// =============================================================================
// Legacy Exports (for backward compatibility)
// =============================================================================

export interface AuthStatus {
  authenticated: boolean;
  user: {
    id: string;
    email?: string;
    name?: string;
    preferredUsername?: string;
  } | null;
  expiresAt: number | null;
}

/**
 * Get auth status in legacy format
 * @deprecated Use auth.isAuthenticated and auth.user instead
 */
export function getAuthStatus(): AuthStatus {
  const user = auth.user;

  return {
    authenticated: !!user,
    user: user
      ? {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          preferredUsername: user.email?.split("@")[0],
        }
      : null,
    expiresAt: null, // Better Auth handles session expiry automatically
  };
}
