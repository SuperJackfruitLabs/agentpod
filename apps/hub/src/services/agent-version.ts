/**
 * agent-version — resolves the latest published agent version from GitHub Releases.
 *
 * Module-level cache with a 1-hour TTL.  On ANY fetch error the last cached
 * value (or null on a cold start) is returned so callers never see a throw.
 *
 * The base URL and fetch implementation are injectable via options so the
 * module is testable without network access.  The cache itself is reset via
 * _resetCache() (test-only helper exported with the underscore prefix).
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GetLatestVersionOptions {
  /** Override the fetch implementation (for tests). */
  fetch?: typeof globalThis.fetch;
  /** Override the GitHub API base URL (for tests). */
  baseUrl?: string;
  /** Override the clock (for testing TTL behavior). */
  now?: () => number;
}

// ─── Module-level cache ───────────────────────────────────────────────────────

/**
 * The repository releases are published to.
 *
 * Named the pre-transfer owner until 2026-08-14 and worked only through
 * GitHub's redirect for a moved repository — which is not a contract. The node
 * agent holds the same constant in `internal/selfupdate`; both must name the
 * repository that actually publishes releases, or a fleet update depends on a
 * redirection nobody controls (issue #295).
 */
const RELEASE_REPO = "SuperJackfruitLabs/agentpod";

let _cache: { value: string | null; at: number } = { value: null, at: 0 };

const TTL_MS = 3_600_000; // 1 hour

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Reset the module-level cache.  Exported for use in tests only.
 */
export function _resetCache(): void {
  _cache = { value: null, at: 0 };
}

/**
 * Return the latest published agent version tag (e.g. "v0.1.3").
 *
 * - Returns the cached value if it was fetched within the last hour.
 * - On fetch failure, returns the last cached value or null (never throws).
 */
export async function getLatestAgentVersion(
  opts: GetLatestVersionOptions = {}
): Promise<string | null> {
  const now = (opts.now ?? (() => Date.now()))();

  // Cache hit
  if (_cache.at !== 0 && now - _cache.at < TTL_MS) {
    return _cache.value;
  }

  const fetchFn = opts.fetch ?? globalThis.fetch;
  const baseUrl = opts.baseUrl ?? "https://api.github.com";

  try {
    const res = await fetchFn(
      `${baseUrl}/repos/${RELEASE_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github.v3+json" } }
    );
    const data = (await res.json()) as { tag_name?: string };
    const tag = data.tag_name ?? null;
    _cache = { value: tag, at: now };
    return tag;
  } catch {
    // On any error: return the stale cached value (or null on cold start).
    return _cache.value;
  }
}

/**
 * Return true iff `latest` is a STRICTLY newer version than `current`.
 *
 * Versions are "vMAJOR.MINOR.PATCH" (leading "v" optional). Anything that does
 * not parse (e.g. "unknown", null) yields false. Using a real ordering — rather
 * than plain inequality — means a stale/older cached "latest" never produces a
 * spurious "update available" (which would read as a downgrade in the UI).
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  // Compare major, then minor, then patch. Literal tuple indices keep each
  // element typed as a definite number (no noUncheckedIndexedAccess widening).
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}
