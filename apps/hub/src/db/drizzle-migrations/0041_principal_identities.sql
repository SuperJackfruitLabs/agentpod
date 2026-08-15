-- The same principal, known by another system.
--
-- The Organization plane owns principals and their identity mappings, and does
-- not exist. This is the manoeuvre the tenancy decision already proved: keep
-- what this plane legitimately owns, record an optional mapping to the same
-- real identity elsewhere, and adopting a canonical principal later becomes a
-- data move rather than a redesign.
--
-- A table rather than columns on "user", which is where this differs from
-- tenancy: a tenant maps to one external organisation, but a principal is
-- legitimately known to several systems at once.
--
-- A RECORD OF SAMENESS, NEVER A GRANT. Nothing may read authority out of these
-- rows. The moment something does, the Organization plane has been built by
-- accident, in the wrong repository, without the control pair meant to come
-- with it.
CREATE TABLE IF NOT EXISTS "principal_identities" (
  "id"           text PRIMARY KEY NOT NULL,
  "principal_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "system"       text NOT NULL,
  "external_id"  text NOT NULL,
  "created_at"   timestamp DEFAULT now() NOT NULL,

  -- Adding a system should be a one-line migration; an enum makes removing one
  -- painful. 'org-plane' is listed before it exists, because the point is that
  -- adopting it changes data and not schema.
  CONSTRAINT "principal_identities_system_known"
    CHECK ("system" IN ('matrix', 'kaambaan', 'org-plane')),

  -- An empty external id is not a mapping; it is a row that looks like one.
  CONSTRAINT "principal_identities_external_id_present"
    CHECK (length("external_id") > 0)
);

-- One external identity belongs to at most one principal. This is what makes
-- the table usable for the thing it exists for: a bridge asking "who sent this
-- Matrix message" needs ONE answer, and two principals claiming one mxid makes
-- that unanswerable exactly when it matters — attributing a human's approval.
CREATE UNIQUE INDEX IF NOT EXISTS "principal_identities_system_external_idx"
  ON "principal_identities" ("system", "external_id");

-- And one identity per system per principal, so the reverse direction — "which
-- mxid do I message this principal at" — also has a single answer.
CREATE UNIQUE INDEX IF NOT EXISTS "principal_identities_principal_system_idx"
  ON "principal_identities" ("principal_id", "system");

CREATE INDEX IF NOT EXISTS "principal_identities_principal_idx"
  ON "principal_identities" ("principal_id");
