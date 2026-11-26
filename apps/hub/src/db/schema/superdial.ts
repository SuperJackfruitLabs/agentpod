/**
 * Each bridge agent's superdial call device (`SUPERDIAL`): a second Matrix device of the agent
 * user, minted once by appservice login and handed to superdial-agent to join calls as.
 *
 * The access token is a live credential for the agent user, so it is kept encrypted with
 * ENCRYPTION_KEY like the hub's other secrets. The appservice token is never handed out; this
 * device's token is the only Matrix credential superdial-agent holds for an agent.
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const superdialCallDevices = pgTable("superdial_call_devices", {
  /** The agent's mxid, `@agent_…:server`. */
  agentUserId: text("agent_user_id").primaryKey(),
  /** Always `SUPERDIAL` today; stored so a reader never has to assume it. */
  deviceId: text("device_id").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
