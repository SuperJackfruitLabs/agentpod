ALTER TABLE "bridge_agents" ADD COLUMN "credential_source" jsonb;
ALTER TABLE "bridge_agents" ADD CONSTRAINT "bridge_agents_credential_source_check" CHECK ("credential_source" IS NULL OR ("token_encrypted" = '' AND "mcp_token_encrypted" IS NULL));
