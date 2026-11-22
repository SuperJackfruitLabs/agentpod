-- A station-plane source row stores no claim token, but may keep the run-scoped MCP token its
-- harness spends for its own board tools, as a token row does. The claim rule is unchanged.
ALTER TABLE "bridge_agents" DROP CONSTRAINT "bridge_agents_credential_source_check";
--> statement-breakpoint
ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_credential_source_check" CHECK ("credential_source" IS NULL OR "token_encrypted" = '');
