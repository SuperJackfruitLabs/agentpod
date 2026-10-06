/** PKCE (RFC 7636) helpers for the console's sign-in through the organization plane. */

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** `bytes` random bytes as base64url, unpadded. 48 bytes → 64 characters, inside RFC 7636's 43-128. */
export function randomUrlSafe(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 code challenge: base64url(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
