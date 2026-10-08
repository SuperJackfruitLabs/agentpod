import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * Which key a station pushes with, and how to withdraw it.
 *
 * `charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md` makes
 * `super-jackfruit-website` forge-primary, so an agent that writes code needs a forge identity —
 * one account per agent per `estate → docs/2026-09-21-forge.md` §7, and one key per station, so a
 * station's access is withdrawable without disturbing the agent's other stations.
 *
 * **There is no secret in this table, on purpose.** The node generates the keypair with
 * `ssh-keygen` and keeps the private half; the hub only registers the public half on the agent's
 * account. That is how forge's own push mirror works — it generated its keypair and handed us
 * only the public key — and it is strictly better than storing a private key encrypted, because
 * a credential the hub never holds is one a hub compromise cannot leak.
 *
 * **`key_id` is the whole point of the row.** forge will not let us search for a key by content,
 * so the numeric id it returns at registration is the only handle revocation has. A row that lost
 * its id would describe a key nobody can withdraw.
 *
 * `public_key` is kept so an operator can see what a station actually pushes with, and compare it
 * against what the node believes it holds, without asking forge.
 *
 * **`provider`** so the parked GitHub App path (agentpod#591) could join without a migration,
 * though a GitHub deploy key is per-repository rather than per-account and would not fit this
 * shape unchanged. Today every row is `forge`.
 */
export const stationGitIdentities = pgTable(
  "station_git_identities",
  {
    /** One per station: a station pushes as one identity, not a pool. */
    stationId: text("station_id")
      .primaryKey()
      .references(() => stations.id, { onDelete: "cascade" }),

    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    provider: text("provider").notNull().default("forge"),

    /**
     * The forge account this station pushes as — what appears in `git log`.
     *
     * Derived by the hub from the station's occupying principal, never taken from the node: a
     * node that could name the account could claim to be a different agent.
     */
    username: text("username").notNull(),

    /** forge's numeric key id. The revocation handle. */
    keyId: integer("key_id").notNull(),

    /** The public half, as registered. Not a secret. */
    publicKey: text("public_key").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /**
     * Who this station's commits are by, as last sent to the node (GIT_AUTHOR_* / GIT_COMMITTER_*
     * in the harness's environment). Null on a row provisioned before authors were sent; the next
     * time the node connects, the hub fills it in and tells the node — no key is touched.
     *
     * The email is forge's, as forge stores it — never constructed here — because it is what forge
     * links a commit to the account by. It is synthetic; an agent has no mailbox.
     */
    authorName: text("author_name"),
    authorEmail: text("author_email"),

    /** Set when a station re-registers — a new key replacing an old one, rather than a first. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  },
  (table) => [index("station_git_identities_tenant_idx").on(table.tenantId)],
);
