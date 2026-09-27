import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

import { tenants } from "./tenants";
import { stations } from "./stations";

/**
 * The git credential one station's agent writes with.
 *
 * `charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md` makes
 * `super-jackfruit-website` forge-primary, so an agent that writes code needs a forge account —
 * one per agent, per `estate → docs/2026-09-21-forge.md` §7, "so a leak or a runaway is
 * attributable and revocable on its own".
 *
 * **A store, not an authorization.** `matrixCredentialAuthorizations` is a single-use record: a
 * human approves one station and the node cashes it in once. This is the opposite, and the
 * difference is forced by git. A credential helper is invoked on *every* fetch and push, so
 * redemption has to be repeatable — a single-use row would authorise the first `git push` of a
 * turn and refuse the second. What makes that safe is that this row is not a grant a node can
 * request: it exists only because an operator provisioned this station, and the node still has to
 * prove it hosts the station before it can read it.
 *
 * **`provider`** so the parked GitHub App path (agentpod#591) can join without a migration. Today
 * every row is `forge`.
 *
 * **`token_name`** because revocation is by name on Forgejo — `DELETE
 * /admin/users/{u}/tokens/{name}` — and a station's credential has to be withdrawable without
 * touching the agent's other stations. Keeping the name here is what makes that possible after
 * the fact; the token itself cannot be read back from forge to identify it.
 *
 * **Forgejo tokens do not expire**, unlike a GitHub App installation token's hour, so there is no
 * `expires_at` and nothing here rotates on a timer. A credential leaves by being revoked, which
 * is why the name matters more than a lifetime would.
 */
export const stationGitCredentials = pgTable(
  "station_git_credentials",
  {
    /** One per station: a station has one working identity, not a pool. */
    stationId: text("station_id")
      .primaryKey()
      .references(() => stations.id, { onDelete: "cascade" }),

    /** Restricts, like every other tenant-scoped row: a tenant holding live credentials is not
     * deletable by accident. */
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),

    /** `forge` today. See the note above. */
    provider: text("provider").notNull().default("forge"),

    /** The account the agent writes as — what shows up in `git log`. */
    username: text("username").notNull(),

    /** AES-256-GCM via `utils/encryption.ts`, as `station_transcription.api_key_encrypted` is. */
    tokenEncrypted: text("token_encrypted").notNull(),

    /** The handle revocation needs. */
    tokenName: text("token_name").notNull(),

    /** JSON array of `owner/repo`, or null for "whatever the account can reach". Recorded so an
     * operator can see what a station was scoped to without asking forge. */
    repositories: text("repositories"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    /** Null until the first redeem, which is a distinct state from "used long ago" — the same
     * distinction `deviceCredentials.lastUsedAt` draws. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [index("station_git_credentials_tenant_idx").on(table.tenantId)],
);
