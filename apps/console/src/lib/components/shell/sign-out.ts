import { goto } from "$app/navigation";
import { logout } from "$lib/stores/auth.svelte";

/**
 * The same sign-out as Settings: forget the tokens here and revoke the refresh token at the
 * organization plane, THEN leave. Going to /login first would let the layout find live tokens
 * and bounce straight back in. It does not end the plane's own session (accounts.…), so
 * "Sign in" afterwards is silent.
 */
let signingOut = false;
export async function signOut(): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  try {
    await logout();
  } finally {
    signingOut = false;
    await goto("/login");
  }
}
