/** Trusted transport and resource identity. Unset URL: all Library features are off. */
export function superlibraryConfig(): { url: string; audience: string } | null {
  const url = (process.env.SUPERLIBRARY_URL ?? "").trim().replace(/\/+$/, "");
  if (url === "") return null;
  const explicit = process.env.SUPERLIBRARY_AUDIENCE;
  if (explicit === undefined) return { url, audience: url };
  const audience = explicit.trim();
  let resource: URL;
  try {
    resource = new URL(audience);
  } catch {
    throw new Error("SUPERLIBRARY_AUDIENCE must be an HTTPS resource identifier");
  }
  if (resource.protocol !== "https:" || resource.username || resource.password || resource.hash) {
    throw new Error("SUPERLIBRARY_AUDIENCE must be an HTTPS resource identifier");
  }
  // Audience equality is exact. In particular, preserve a registered trailing slash.
  // A refusal is never retried with the transport URL or a second audience.
  return { url, audience };
}
