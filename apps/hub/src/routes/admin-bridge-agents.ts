/**
 * The bridge roster, as an operator surface.
 *
 * This is what replaces editing `SUPERPIPELINE_BRIDGE_AGENTS` in `hub.env` and restarting the
 * hub. Adding an agent, rotating its credential or disabling it is now four routes and a form,
 * and the running loops follow within one reconcile tick — see `services/bridge/reconcile.ts`.
 *
 * **Mounted inside the same admin guard as the rest of `/api/admin`.** Not because the list is
 * secret — it names boards and stations, which the console shows anyway — but because every write
 * here decides what work this fleet claims and whose credential it spends. That is workspace
 * administration, the same class as minting a token or granting reach.
 *
 * **No route returns a credential.** The list surface is `listBridgeAgents`, which answers
 * `hasToken` and `hasMcpToken`; there is no parameter that makes it answer more, and a write
 * replies with that same shape rather than echoing what it was given. The only reader of the
 * plaintext is the bridge itself.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { AcpSessionMode } from "@agentpod/contract";
import { resolveTenantForUser } from "../auth/tenant";
import { createLogger } from "../utils/logger";
import {
  createBridgeAgent,
  deleteBridgeAgent,
  listBridgeAgents,
  updateBridgeAgent,
} from "../services/bridge/roster";

const log = createLogger("admin-bridge-agents");

/** superpipeline's own id grammar, matched here so a typo is a 400 rather than a silent no-op. */
const BOARD_ID = z.string().regex(/^brd_[0-9a-f]{16}$/, "a superpipeline board id looks like brd_<16 hex>");
const AGENT_TOKEN = z.string().startsWith("spa_", 'a superpipeline agent token starts with "spa_"');

const createSchema = z.object({
  key: z.string().min(1).max(64),
  boardId: BOARD_ID,
  stationId: z.string().min(1),
  token: AGENT_TOKEN,
  /**
   * The second, `run`-scoped credential — the one the HARNESS spends over MCP so a dispatched
   * agent can complete or block its own card. Never the same as `token`, which can also claim.
   */
  mcpToken: AGENT_TOKEN.nullish(),
  mode: AcpSessionMode.optional(),
  permissionWaitMs: z.number().int().positive().nullish(),
  maxConcurrency: z.number().int().positive().nullish(),
  profileKey: z.string().min(1).nullish(),
  enabled: z.boolean().optional(),
});

/** Every field optional, but at least one present — an empty PATCH is a mistake, not a no-op. */
const updateSchema = createSchema.omit({ key: true }).partial().refine(
  (patch) => Object.keys(patch).length > 0,
  { message: "nothing to change" },
);

export const adminBridgeAgentsRouter = new Hono()
  .get("/", async (c) => {
    const userId = c.get("user")!.id;
    const tenantId = await resolveTenantForUser(userId);
    return c.json({ agents: await listBridgeAgents(tenantId) });
  })

  .post("/", zValidator("json", createSchema), async (c) => {
    const userId = c.get("user")!.id;
    const tenantId = await resolveTenantForUser(userId);
    const body = c.req.valid("json");

    try {
      await createBridgeAgent({ ...body, tenantId, createdBy: userId });
    } catch (err) {
      // The database is the authority on whether this is representable: the composite foreign key
      // refuses a station in another tenant, the primary key refuses a duplicate name. Reporting
      // its refusal is more honest than re-deriving the rules here and disagreeing with it.
      return c.json({ error: refusal(err) }, 400);
    }

    const agents = await listBridgeAgents(tenantId);
    return c.json({ agent: agents.find((a) => a.key === body.key) }, 201);
  })

  .patch("/:key", zValidator("json", updateSchema), async (c) => {
    const userId = c.get("user")!.id;
    const tenantId = await resolveTenantForUser(userId);
    const key = c.req.param("key");

    let changed: boolean;
    try {
      changed = await updateBridgeAgent(tenantId, key, c.req.valid("json"));
    } catch (err) {
      return c.json({ error: refusal(err) }, 400);
    }
    if (!changed) return c.json({ error: "no such agent" }, 404);

    const agents = await listBridgeAgents(tenantId);
    return c.json({ agent: agents.find((a) => a.key === key) });
  })

  .delete("/:key", async (c) => {
    const userId = c.get("user")!.id;
    const tenantId = await resolveTenantForUser(userId);
    const removed = await deleteBridgeAgent(tenantId, c.req.param("key"));
    if (!removed) return c.json({ error: "no such agent" }, 404);
    return c.json({ removed: true });
  });

/**
 * A database refusal an operator can act on.
 *
 * The constraint name comes off `err.cause` — postgres.js puts `constraint_name` there, and
 * Drizzle's own `message` is only "Failed query: …". Matching on the message instead looked like
 * it worked and never fired.
 *
 * **The raw text is never returned**, and that is not tidiness. Drizzle's message includes the
 * bound parameters, which for this table means the ENCRYPTED credential — so passing it through
 * would publish ciphertext to anyone who could provoke an insert error. An unrecognised failure
 * gets a flat sentence, and the real one goes to the log.
 */
function refusal(err: unknown): string {
  const cause = (err as { cause?: { constraint_name?: string; code?: string } })?.cause;
  switch (cause?.constraint_name) {
    case "bridge_agents_station_tenant_fk":
      return "no such station in this workspace";
    case "bridge_agents_tenant_id_key_pk":
      return "an agent with that name already exists — keys appear in the ledger and in every log line, so they must be unique";
    case "bridge_agents_board_grammar_check":
      return "that is not a superpipeline board id";
    case "bridge_agents_mode_check":
      return "unknown permission mode";
    case "bridge_agents_wait_check":
      return "the permission wait must be a positive number of milliseconds";
    case "bridge_agents_concurrency_check":
      return "concurrency must be at least 1";
    case "bridge_agents_created_by_user_id_fk":
      return "no such user";
  }
  log.error("a bridge roster write was refused", {
    error: err instanceof Error ? err.message : String(err),
    constraint: cause?.constraint_name,
    code: cause?.code,
  });
  return "the roster would not accept that — see the hub log for why";
}
