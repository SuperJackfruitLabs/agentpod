/**
 * A node registers the key one of its stations will push with.
 *
 * `station-matrix-credential.ts`'s sibling in its refusals, and they are **copied rather than
 * re-derived** — same `Bearer <nodeId>:<nodeSecret>` parsing, same rule that a credential
 * verifying for a different node than the path names is refused exactly like a wrong secret, and
 * the same collapse of "no such station" and "hosted by another node" into one identical 403,
 * because telling them apart lets a node probe its neighbours' station ids.
 *
 * **It carries no secret in either direction, which is the difference from that sibling.** The
 * node generates the keypair and keeps the private half; this registers the public half. An
 * earlier draft of this feature had the hub store an encrypted token and hand it back on every
 * `git push` — that coupled every push to the hub being up, and put a credential in the database
 * that this design never creates.
 *
 * **The account is derived, never supplied.** The forge username comes from the station's
 * occupying principal. A node that could name the account in the request could register its key
 * against a different agent and push as it.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { principalHandle } from "../services/principals";
import { registerStationGitIdentity } from "../services/station-git-identity";
import type { FetchLike, ForgeConfig } from "../services/forge";
import { createLogger } from "../utils/logger";

const log = createLogger("station-git-identity-route");

export interface StationGitIdentityDeps {
  /** Null when no forge admin credential is configured; every request then answers 503. */
  forge: ForgeConfig | null;
  /** Injected so a test can exercise the route without a forge. Production leaves it unset. */
  fetchImpl?: FetchLike;
}

/** An OpenSSH public key line, loosely: a known type, base64, optional comment. Rejected early so
 * a typo fails here rather than as an opaque refusal from forge. */
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( .*)?$/;

export function createStationGitIdentityRoutes(deps: StationGitIdentityDeps) {
  return new Hono().post("/nodes/:nodeId/stations/:stationId/git-identity", async (c) => {
    const nodeId = c.req.param("nodeId");
    const stationId = c.req.param("stationId");

    const auth = c.req.header("Authorization") ?? "";
    const bearer = auth.replace(/^Bearer\s+/, "");
    const idx = bearer.indexOf(":");
    const credNodeId = idx !== -1 ? bearer.slice(0, idx) : "";
    const nodeSecret = idx !== -1 ? bearer.slice(idx + 1) : "";

    if (
      !credNodeId ||
      !nodeSecret ||
      credNodeId !== nodeId ||
      !(await verifyNodeCredential(credNodeId, nodeSecret))
    ) {
      return c.json({ error: "invalid node credential" }, 401);
    }

    const [station] = await db.select().from(stations).where(eq(stations.id, stationId));

    // Identical refusal for a station that does not exist and one hosted elsewhere.
    if (!station || station.nodeId !== nodeId) {
      return c.json({ error: "station not hosted by this node" }, 403);
    }

    const handle = station.principalId ? await principalHandle(station.principalId) : null;
    if (!handle) {
      // The ordinary state of a station nobody has put an agent on, said distinctly (409) exactly
      // as its sibling does. There is no account to register a key against.
      return c.json({ error: "station has no occupying principal" }, 409);
    }

    if (!deps.forge) {
      // Said rather than failed: a hub with no forge admin credential cannot do this, and that is
      // a deployment fact the node should report rather than retry against.
      return c.json({ error: "this hub has no forge credential configured" }, 503);
    }

    let body: { publicKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey.trim() : "";
    if (!PUBLIC_KEY.test(publicKey)) {
      return c.json({ error: "publicKey is not an OpenSSH public key" }, 400);
    }

    const identity = await registerStationGitIdentity(
      deps.forge,
      { stationId, tenantId: station.tenantId, username: handle, publicKey },
      deps.fetchImpl,
    );

    log.info("station git identity registered", { nodeId, stationId, username: identity.username });
    return c.json({ username: identity.username, keyId: identity.keyId, rotated: identity.rotated });
  });
}
