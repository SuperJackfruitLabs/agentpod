-- Each bridge agent's superdial call device: device id `SUPERDIAL`, minted once by appservice login
-- and reused. The token is a live credential for the agent user, stored encrypted (ENCRYPTION_KEY).
CREATE TABLE IF NOT EXISTS "superdial_call_devices" (
	"agent_user_id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
