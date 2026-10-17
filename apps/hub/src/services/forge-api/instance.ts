/**
 * Which forge a grant points at.
 *
 * A minted token is minted by THIS hub's configured forge (FORGE_URL), and stk injects it on every
 * request to the grant's `instance`. If the two differed, the hub's token for its own forge would be
 * handed to whatever https host an operator typed. So a minted grant's instance must be the
 * configured forge's origin, exactly — compared here, by the service, before anything happens.
 *
 * A trailing-dot host (`forge.example.`) is the same host to DNS but a different string to every
 * origin comparison and to stk's matcher, so it is refused on BOTH sides rather than stripped.
 */

/** The https origin of a URL, or null if it is not https, carries userinfo, or has a trailing-dot host. */
export function canonicalOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.hostname.endsWith(".")) return null;
  return u.origin;
}

/** A grant instance: a bare https origin (path `/` at most, no query or fragment). */
export function instanceOrigin(instance: string): string | null {
  const origin = canonicalOrigin(instance);
  if (!origin) return null;
  const u = new URL(instance);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || instance.includes("?") || instance.includes("#")) {
    return null;
  }
  return origin;
}

/** Is `instance` the configured forge? False when no forge is configured: fail closed. */
export function isConfiguredForge(instance: string, forgeUrl: string | null | undefined): boolean {
  if (!forgeUrl) return false;
  const a = instanceOrigin(instance);
  const b = canonicalOrigin(forgeUrl);
  return a !== null && b !== null && a === b;
}

/** An IPv4 or IPv6 literal host (`URL.hostname` keeps IPv6 brackets). */
export function isIpLiteral(hostname: string): boolean {
  return hostname.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}
