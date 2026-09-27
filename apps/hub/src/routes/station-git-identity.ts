/**
 * Station Git Identity Routes — POST   /api/stations/:id/git-identity
 *                               DELETE /api/stations/:id/git-identity
 *                               GET    /api/stations/:id/git-identity
 *
 * Giving one station the ability to push to forge, and taking it away.
 *
 * **Explicit, and decided here.** Most stations never touch git; handing every adopted station a
 * forge key would create accounts nobody uses and keys nobody revokes. So provisioning is an
 * operator action against a named station, not a side effect of adoption.
 *
 * **No secret moves in either direction.** The node generates the keypair and keeps the private
 * half — `git.identity.ensure` returns only the public one. This hub holds the forge admin token
 * and registers that public key itself. An earlier draft had the hub store an encrypted push
 * token and hand it back on every `git push`; that coupled every push to the hub being up and put
 * a credential in the database this design never creates.
 *
 * **The account is derived, never supplied.** The forge username comes from the station's
 * occupying principal, so a request cannot aim a key at somebody else's agent.
 *
 * Safety model mirrors `station-changeset.ts`: authenticate → ownership via `getStation` →
 * preconditions → `broker.request` → respond. Node-offline → 409; other broker errors → 502.
 *
 * Replaces the node-credentialled `POST /api/nodes/:nodeId/stations/:stationId/git-identity` that
 * shipped in #594. With the hub deciding which stations get identities, the node has nothing to
 * announce and no reason to call in; that route had no caller. `registerStationGitIdentity`
 * beneath it is unchanged and is what this uses.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";

import { db } from "../db/drizzle";
import { stationGitIdentities } from "../db/schema/git-identities";
import * as broker from "../services/broker";
import { getStation } from "../services/station-registry";
import { principalHandle } from "../services/principals";
import { recordAudit } from "../services/audit";
import {
  registerStationGitIdentity,
  revokeStationGitIdentity,
} from "../services/station-git-identity";
import { VERB_RESULTS } from "@agentpod/contract";
import type { FetchLike, ForgeConfig } from "../services/forge";
import { createLogger } from "../utils/logger";
import type { AuthUser } from "../auth/middleware";

const log = createLogger("station-git-identity-route");

export interface StationGitIdentityDeps {
  /** Null when no forge admin credential is configured; provisioning then answers 503. */
  forge: ForgeConfig | null;
  /** Injected so a test can exercise the route without a forge. Production leaves it unset. */
  fetchImpl?: FetchLike;
}

function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

/** An OpenSSH public key line, loosely: a known type, base64, optional comment.
 *
 * Checked in ADDITION to the contract schema, which can only say "a string". A node that answered
 * with something that is not a key would otherwise fail inside forge, which refuses a bad key with
 * `{"message":"%!s(<nil>)"}` — a message that names neither the field nor the problem. */
const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+( .*)?$/;

export function createStationGitIdentityRoutes(deps: StationGitIdentityDeps) {
  return (
    new Hono()

      /** What this station can push as, if anything. Cheap, so no audit row. */
      .get("/stations/:id/git-identity", async (c) => {
        const user = c.get("user") as AuthUser | undefined;
        if (!user || user.id === "anonymous") {
          return c.json({ error: "Unauthorized" }, 401);
        }
        const station = await getStation(user.id, c.req.param("id"));
        if (!station) {
          return c.json({ error: "Not Found" }, 404);
        }

        const [row] = await db
          .select()
          .from(stationGitIdentities)
          .where(eq(stationGitIdentities.stationId, station.id));
        if (!row) {
          return c.json({ identity: null });
        }
        // The public key is returned; it is public. `keyId` is the revocation handle and is the
        // reason this row exists at all — forge cannot be asked to find a key by its content.
        return c.json({
          identity: {
            provider: row.provider,
            username: row.username,
            keyId: row.keyId,
            publicKey: row.publicKey,
            rotatedAt: row.rotatedAt,
          },
        });
      })

      /** Provision, or rotate an existing one. */
      .post("/stations/:id/git-identity", async (c) => {
        const user = c.get("user") as AuthUser | undefined;
        if (!user || user.id === "anonymous") {
          return c.json({ error: "Unauthorized" }, 401);
        }

        const station = await getStation(user.id, c.req.param("id"));
        if (!station) {
          return c.json({ error: "Not Found" }, 404);
        }

        const handle = station.principalId ? await principalHandle(station.principalId) : null;
        if (!handle) {
          // The ordinary state of a station nobody has put an agent on. There is no account to
          // register a key against, and inventing one would create an account with no owner.
          return c.json({ error: "station has no occupying principal" }, 409);
        }

        // Checked before the node is asked: generating a keypair the hub then cannot register
        // leaves a private key on disk with nothing to push to.
        if (!deps.forge) {
          return c.json({ error: "this hub has no forge credential configured" }, 503);
        }

        // Audited before the call, not after: this grants push access to a repository, which is
        // the kind of thing that must leave a record even when it then fails.
        const audit = await recordAudit(db, {
          userId: user.id,
          nodeId: station.nodeId,
          stationKey: station.stationKey,
          verb: "git.identity.ensure",
          params: { username: handle },
        });

        // Both names, because each side knows the station by only one of them. The id is stable
        // across a rename and is what revocation uses; the key is the only name the node's own
        // spawn path has to look an identity up by.
        const result = await broker.request(station.nodeId, "git.identity.ensure", {
          stationId: station.id,
          stationKey: station.stationKey,
        });
        if (!result.ok) {
          await audit.done("error", result.error).catch(() => {});
          return c.json(
            { error: result.error ?? "git.identity.ensure failed" },
            brokerErrorStatus(result.error),
          );
        }

        const parsed = VERB_RESULTS["git.identity.ensure"].safeParse(result.data);
        const publicKey = parsed.success ? parsed.data.publicKey.trim() : "";
        if (!PUBLIC_KEY.test(publicKey)) {
          await audit.done("error", "node returned no usable public key").catch(() => {});
          return c.json({ error: "node returned no usable public key" }, 502);
        }

        let identity;
        try {
          identity = await registerStationGitIdentity(
            deps.forge,
            {
              stationId: station.id,
              tenantId: station.tenantId,
              username: handle,
              publicKey,
            },
            deps.fetchImpl,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await audit.done("error", message).catch(() => {});
          // 502: forge is upstream of this hub, and its refusals are not the caller's mistake.
          return c.json({ error: message }, 502);
        }

        await audit.done("ok").catch(() => {});
        log.info("station git identity provisioned", {
          stationId: station.id,
          username: identity.username,
          rotated: identity.rotated,
        });
        return c.json({
          username: identity.username,
          keyId: identity.keyId,
          rotated: identity.rotated,
          publicKey,
        });
      })

      /** Withdraw. */
      .delete("/stations/:id/git-identity", async (c) => {
        const user = c.get("user") as AuthUser | undefined;
        if (!user || user.id === "anonymous") {
          return c.json({ error: "Unauthorized" }, 401);
        }

        const station = await getStation(user.id, c.req.param("id"));
        if (!station) {
          return c.json({ error: "Not Found" }, 404);
        }
        if (!deps.forge) {
          return c.json({ error: "this hub has no forge credential configured" }, 503);
        }

        const audit = await recordAudit(db, {
          userId: user.id,
          nodeId: station.nodeId,
          stationKey: station.stationKey,
          verb: "git.identity.remove",
          params: {},
        });

        let revoked: boolean;
        try {
          // forge first, and this is the step that matters: once the key is off the account it
          // cannot push, whatever is still on disk.
          revoked = await revokeStationGitIdentity(deps.forge, station.id, deps.fetchImpl);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await audit.done("error", message).catch(() => {});
          return c.json({ error: message }, 502);
        }

        // Then the node's copy — best effort, deliberately. A revoked key is already useless, so
        // an offline node must not turn a completed withdrawal into a failure. What this buys is
        // that `git.identity.ensure` cannot later hand the same key to a different agent, so a
        // node that was offline for its own cleanup is worth reporting.
        const cleaned = await broker.request(station.nodeId, "git.identity.remove", {
          stationId: station.id,
        });
        if (!cleaned.ok) {
          log.warn("git identity revoked on forge but the node kept its key file", {
            stationId: station.id,
            nodeId: station.nodeId,
            error: cleaned.error,
          });
        }

        await audit.done("ok").catch(() => {});
        return c.json({ revoked, nodeCleaned: cleaned.ok });
      })
  );
}
