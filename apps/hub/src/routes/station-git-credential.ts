/**
 * A node redeems one of its stations' git credentials.
 *
 * `station-matrix-credential.ts`'s sibling, and its refusals are **copied rather than
 * re-derived** — same `Bearer <nodeId>:<nodeSecret>` parsing, same rule that a credential
 * verifying for a different node than the path names is refused exactly like a wrong secret, and
 * the same collapse of "no such station" and "hosted by another node" into one 403, because
 * telling them apart lets a node probe another node's station ids by reading 403 against 404.
 *
 * **One difference, and it is forced by git.** The Matrix credential is redeemed once, against a
 * single-use authorisation a human minted. A git credential helper runs on every fetch and push,
 * so this is repeatable: it reads a credential an operator provisioned rather than cashing in an
 * approval. The station check is what bounds it — a node can only ever read the credentials of
 * stations it hosts, and only ones somebody deliberately gave a git identity to.
 *
 * Mounted under `/api` beside its sibling, which is where a node-credentialled route already
 * lives — `station-matrix-credential.ts` and `station-token.ts` both answer a `Bearer
 * <nodeId>:<nodeSecret>` there. Following the closest analogue rather than the bridge push, which
 * sits under `/public` because its caller is a Cloudflare Worker with a shared signing secret.
 *
 * The hub never logs the token it hands back. The audit line names the station, as its sibling
 * names the device id and not the credential.
 */
import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stations } from "../db/schema/stations";
import { verifyNodeCredential } from "../services/enrollment";
import { readStationGitCredential } from "../services/station-git-credential";
import { createLogger } from "../utils/logger";

const log = createLogger("station-git-credential-route");

export function createStationGitCredentialRoutes() {
  return new Hono().post("/nodes/:nodeId/stations/:stationId/git-credential", async (c) => {
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

    const credential = await readStationGitCredential(stationId);
    if (!credential) {
      // The ordinary state of a station nobody has given a git identity to, said distinctly (409)
      // exactly as its sibling says "station has no occupying principal". A node that gets this
      // should stop asking, not retry.
      return c.json({ error: "station has no git credential" }, 409);
    }

    log.info("git credential redeemed", { nodeId, stationId, username: credential.username });
    return c.json({ username: credential.username, token: credential.token });
  });
}

/** The hub's own git-credential route. */
export const stationGitCredentialRoutes = createStationGitCredentialRoutes();
