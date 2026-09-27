-- Columns Better Auth 1.7 checks for at startup.
--
-- 1.7.3 turned on schema validation by default, in production too: when the
-- Drizzle schema lacks a column an enabled plugin writes, it logs "Drizzle schema
-- mismatch" and rejects every auth request — sign-in, /api/auth/token and
-- /api/auth/jwks included. 1.6 never looked, so these gaps were silent:
--
--   jwks.alg, jwks.crv            jwt plugin; written on key creation
--   user.ban_reason, ban_expires  admin plugin's ban endpoints
--   session.impersonated_by       admin plugin's impersonation
--
-- All nullable, no defaults, no backfill: on Postgres each ADD COLUMN is a
-- catalog-only change. The existing jwks row keeps alg/crv null, which the
-- plugin reads as keyPairConfig's alg (EdDSA), so the published key set is
-- unchanged.
--
-- The generated snapshot for this migration also absorbs 0066's constraint
-- change, which was hand-written without one; the matching DROP/ADD CONSTRAINT
-- drizzle-kit emitted here was removed, since 0066 already applied it.
ALTER TABLE "jwks" ADD COLUMN "alg" text;--> statement-breakpoint
ALTER TABLE "jwks" ADD COLUMN "crv" text;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamp;
