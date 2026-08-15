-- Better Auth's signing keys, behind /api/auth/token and /api/auth/jwks.
--
-- The plugin was wired with no table behind it: that typechecks, passes every
-- unit test, and 500s the first time a caller asks for a token. Storage that a
-- feature needs is part of the feature.
--
-- Column names are the plugin's own (camelCase, quoted) because its adapter
-- reads them by those names. Renaming them to this schema's snake_case house
-- style would look tidier and break the plugin at runtime.
--
-- No unique constraint on the key material and no NOT NULL on "expiresAt":
-- several rows coexist ON PURPOSE. /api/auth/jwks publishes all of them and
-- signing uses the newest "createdAt", which is exactly what makes an
-- overlapping key rotation possible — insert the new key, let old tokens drain,
-- then delete the old row.
CREATE TABLE IF NOT EXISTS "jwks" (
  "id"         text PRIMARY KEY NOT NULL,
  "publicKey"  text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt"  timestamp DEFAULT now() NOT NULL,
  "expiresAt"  timestamp
);
