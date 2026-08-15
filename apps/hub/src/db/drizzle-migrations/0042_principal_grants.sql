-- The control pair, as data the issuer can read.
--
-- Decision 4 of the ecosystem-identity decision gives the Organization plane
-- authority over two questions: who may dispatch which agent, and who may grant
-- an agent its reach. It blessed a static-configuration interim PROVIDED the
-- config took the shape of the eventual claim. This is that claim arriving.
--
-- One row per principal, and the principal IS the key: two rows would be two
-- answers to a question that must have one, and "which row wins" is not a
-- question an authorization check should ever have to ask.
--
-- may_dispatch is JSON text rather than text[] because the value travels into a
-- JWT claim verbatim; a round trip through an array type adds a shape conversion
-- exactly where the stored and wire formats must not diverge.
CREATE TABLE IF NOT EXISTS "principal_grants" (
  "principal_id"    text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "may_dispatch"    text NOT NULL DEFAULT '[]',
  "may_grant_reach" boolean NOT NULL DEFAULT false,
  "created_at"      timestamp DEFAULT now() NOT NULL,
  "updated_at"      timestamp DEFAULT now() NOT NULL,

  -- Checked here as well as in the service. The service is where a good error
  -- message lives; this is where the guarantee lives. The one thing worse than
  -- a missing grant is a malformed one that some reader interprets generously.
  CONSTRAINT "principal_grants_may_dispatch_is_array" CHECK ("may_dispatch" LIKE '[%]')
);
