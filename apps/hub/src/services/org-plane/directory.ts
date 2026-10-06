/**
 * Principal reads from the org plane, cached for 60 s, with the last good answer served while the
 * plane is unreachable — the same posture as the JWKS cache (design Risks #2) — but for at most
 * 15 minutes after that answer was fetched. Past that, the read throws like a cold miss, so the
 * dispatch and answer paths fail closed with `org_plane_unavailable` instead of honouring a grant
 * the plane may have revoked hours ago (security review finding 7c).
 *
 * 404 is an answer (cached as null). A network failure or a 5xx with nothing cached is thrown as
 * the `OrgPlaneError` it is, so the caller fails closed and can say the plane is down instead of
 * "I do not recognise you". A 4xx other than 404 is never papered over with a stale entry: the
 * plane answered, and the answer was a refusal.
 *
 * Used only on the paths that have no token to read from: a Matrix sender (design §5.7's one named
 * exception) and its grant, and the display reads (handles, the admin list, superwitness's
 * principal lookup). Every token-bearing door authorizes from the token and never calls this.
 */
import { OrgPlaneError, orgPlaneClient, type OrgPlaneClient, type PlaneIdentity, type PlaneKind, type PlanePrincipal } from "./client";

export interface PrincipalDirectory {
  principal(id: string): Promise<PlanePrincipal | null>;
  identity(system: string, externalId: string): Promise<PlaneIdentity | null>;
  list(kind?: PlaneKind): Promise<PlanePrincipal[]>;
  invalidate(id?: string): void;
}

const transient = (e: unknown) => e instanceof OrgPlaneError && (e.status === 0 || e.status >= 500);

export function createPrincipalDirectory(o: {
  client: () => Pick<OrgPlaneClient, "getPrincipal" | "lookupIdentity" | "listPrincipals">;
  ttlMs?: number;
  /** How old a last-good answer may be and still stand in for an unreachable plane. */
  maxStaleMs?: number;
  now?: () => number;
}): PrincipalDirectory {
  const ttl = o.ttlMs ?? 60_000;
  const maxStale = o.maxStaleMs ?? 15 * 60_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { value: unknown; at: number }>();

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttl) return hit.value as T;
    try {
      const value = await load();
      cache.set(key, { value, at: now() });
      return value;
    } catch (e) {
      if (hit && transient(e) && now() - hit.at < maxStale) return hit.value as T;
      throw e;
    }
  }

  return {
    principal: (id) => cached(`p:${id}`, () => o.client().getPrincipal(id)),
    identity: (system, ext) => cached(`i:${system}:${ext}`, () => o.client().lookupIdentity(system, ext)),
    // The plane lists one kind per call (contract §3.5); "all" is three calls, cached as one.
    list: (kind) =>
      cached(`l:${kind ?? "*"}`, async () =>
        kind
          ? o.client().listPrincipals(kind)
          : (await Promise.all((["human", "agent", "service"] as const).map((k) => o.client().listPrincipals(k)))).flat(),
      ),
    invalidate: (id) => {
      if (!id) return cache.clear();
      cache.delete(`p:${id}`);
      for (const k of cache.keys()) if (k.startsWith("l:")) cache.delete(k);
    },
  };
}

let singleton: PrincipalDirectory | null = null;
let override: PrincipalDirectory | null = null;

/** The directory for the configured plane. Callers check `orgPlane()` first; legacy never gets here. */
export function principalDirectory(): PrincipalDirectory {
  if (override) return override;
  singleton ??= createPrincipalDirectory({ client: orgPlaneClient });
  return singleton;
}

export function setPrincipalDirectoryForTests(d: PrincipalDirectory | null): () => void {
  const previous = override;
  override = d;
  return () => {
    override = previous;
  };
}
