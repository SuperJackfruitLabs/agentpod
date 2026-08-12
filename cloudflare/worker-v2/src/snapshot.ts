/**
 * Workspace snapshot routes.
 *
 * Cloudflare container disk is ephemeral — "when a Container instance goes to
 * sleep, the next time it is started, it will have a fresh disk as defined by
 * its container image". Without this module a Cloudflare station destroys the
 * user's work every time it idles out, which is exactly what happened on
 * 2026-08-12 (a README.md written at 04:56 was gone at 04:59:58).
 *
 * The container archives its workspace here and restores it on the next start.
 *
 * SECURITY — the container authenticates with a PER-SANDBOX token, never the
 * worker admin token. That token buys exactly two things: read and write of its
 * own archive. It cannot create or destroy sandboxes, it cannot touch another
 * sandbox's archive, and it cannot delete even its own (a compromised harness
 * must not be able to erase the user's work). Deletion happens only on the
 * admin-authenticated destroy path.
 */

import { bearerToken, tokenMatches } from "./auth";

/** R2 key for a sandbox's workspace archive. */
export const snapshotKey = (id: string) => `snapshots/${id}.tar.gz`;

/** Storage and token lookup, injected so the routes are testable without R2. */
export interface SnapshotDeps {
  /** The sandbox's stored snapshot token, or null if the sandbox is unknown. */
  tokenFor(id: string): Promise<string | null>;
  get(key: string): Promise<{ body: unknown } | null>;
  put(key: string, body: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

const json = (body: unknown, status: number) =>
  Response.json(body as Record<string, unknown>, { status });

/** What destroying a sandbox needs, beyond the archive storage itself. */
export interface DestroyDeps extends SnapshotDeps {
  revokeToken(): Promise<void>;
  destroy(): Promise<void>;
}

/**
 * Destroy a sandbox and its archive, in an order that actually holds.
 *
 * **Revoke first.** `destroy()` sends SIGTERM, and the dying container archives
 * its workspace on the way out. Deleting the object before that upload lands
 * loses the race and the archive comes back — observed live on 2026-08-12, when
 * a destroy returned 200 and left the object in R2, leaking paid storage for a
 * runtime nobody could ever reach again. With the token revoked the late upload
 * is refused, so the delete below is final.
 */
export async function handleDestroy(id: string, deps: DestroyDeps): Promise<void> {
  await deps.revokeToken();
  await deps.destroy();
  await deps.delete(snapshotKey(id));
}

/**
 * Handle GET (restore) and PUT (snapshot) for one sandbox's archive.
 *
 * Returns 401 for any token that is absent, wrong, or belongs to a different
 * sandbox — including the case where the sandbox has no stored token at all,
 * so a destroyed sandbox's container cannot keep writing to R2.
 */
export async function handleSnapshot(
  id: string,
  method: string,
  request: Request,
  deps: SnapshotDeps
): Promise<Response> {
  const expected = await deps.tokenFor(id);
  if (!tokenMatches(bearerToken(request), expected ?? undefined)) {
    return json({ error: "unauthorized" }, 401);
  }

  const key = snapshotKey(id);

  if (method === "GET") {
    const object = await deps.get(key);
    // A missing archive is the normal first-boot case, not a failure. The
    // entrypoint must be able to tell it apart from a real error without
    // guessing, so it gets its own status.
    if (!object) return json({ error: "no snapshot" }, 404);
    return new Response(object.body as BodyInit, {
      status: 200,
      headers: { "Content-Type": "application/gzip" },
    });
  }

  if (method === "PUT") {
    await deps.put(key, request.body ?? (await request.arrayBuffer()));
    return json({ ok: true }, 200);
  }

  return json({ error: "method not allowed" }, 405);
}
