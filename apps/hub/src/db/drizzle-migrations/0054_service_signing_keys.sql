-- The key this hub signs SERVICE ASSERTIONS with, kept apart from the key it
-- signs a person's own session token with.
--
-- Both are published in the same JWKS and both verify identically at kaambaan,
-- so this buys nothing cryptographically. What it buys is that the two kinds of
-- authority stay separable:
--
--   * a token minted from a human's own session — they were here, they signed in
--   * a token the Application Service minted asserting a human it has never met,
--     on the strength of a Matrix message and a `principal_identities` row
--
-- charter decisions/2026-08-14-approvals-cross-planes-as-events.md turns on the
-- second existing at all. It should not therefore be indistinguishable from the
-- first. A separate key means revoking the bridge's ability to speak for people
-- is deleting one row, and does not sign every human out of the console.
--
-- Deliberately NOT the `jwks` table, even though that one is already published.
-- Better Auth signs with whichever row has the newest `createdAt`
-- (plugins/jwt/adapter.mjs, getLatestKey), so inserting here would silently take
-- over session signing — and relying on a backdated timestamp to prevent that
-- is the kind of subtlety that survives exactly until the next rotation.
CREATE TABLE IF NOT EXISTS service_signing_keys (
  kid         text PRIMARY KEY,
  public_jwk  text NOT NULL,
  private_jwk text NOT NULL,
  created_at  timestamp NOT NULL DEFAULT now(),
  retired_at  timestamp
);

-- Rotation has the same shape as the jwks table's: insert a newer key, let old
-- tokens drain, then retire the old row. A retired key keeps verifying at a
-- consumer until its JWKS cache expires, so retiring is not a revocation lever —
-- the same sharp edge #331 measured.
CREATE INDEX IF NOT EXISTS service_signing_keys_active_idx
  ON service_signing_keys (created_at DESC) WHERE retired_at IS NULL;
