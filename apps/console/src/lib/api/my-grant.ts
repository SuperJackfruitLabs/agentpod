/**
 * What this browser's principal may do, according to the issuer.
 *
 * Read out of the principal's own token rather than from a new endpoint — the
 * hub already mints one at `/api/auth/token` carrying `mayDispatch` and
 * `mayGrantReach`, and kaambaan's web app reads it the same way (kaambaan#43).
 *
 * **Advisory only.** The hub decides; this exists so a control that will be
 * refused can say so before it is clicked. When it cannot find out it answers
 * *permitted* and lets the hub refuse: guessing "denied" would hide a control
 * the operator actually holds — possibly on a deployment where the pair is not
 * even enforced — which is the worse of the two wrong answers.
 */

import { http } from "./client";

export interface MyReach {
  mayGrantReach: boolean;
}

/** The answer when the issuer cannot be asked, or does not speak the pair yet. */
const PERMITTED: MyReach = { mayGrantReach: true };

let cached: Promise<MyReach> | null = null;

/** Claims without verifying — the hub verifies; this only decides what to grey out. */
function claimsOf(jwt: string): Record<string, unknown> | null {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return null;
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

export function myReach(): Promise<MyReach> {
  // One mint per page load. The claim cannot change without an admin editing a
  // grant, and a stale answer only ever costs a 403 the hub would give anyway.
  if (cached) return cached;

  cached = (async () => {
    try {
      const { token } = await http<{ token?: string }>("/api/auth/token");
      const claims = token ? claimsOf(token) : null;
      if (!claims || typeof claims.mayGrantReach !== "boolean") return PERMITTED;
      return { mayGrantReach: claims.mayGrantReach };
    } catch {
      return PERMITTED;
    }
  })();

  return cached;
}

/** Drop the cached answer — after signing out, or in tests. */
export function forgetMyReach(): void {
  cached = null;
}
