import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { EnrollRequest } from "@agentpod/contract";
import { enrollNode, verifyNodeCredential } from "../services/enrollment";
import { listNodes } from "../services/node-registry";
import {
  executeRollout,
  planRollout,
  summarise,
  type RolloutNode,
} from "../services/rollout";
import { request as brokerRequest } from "../services/broker";

// ─── Types ────────────────────────────────────────────────────────────────────

type RequestFn = (
  nodeId: string,
  verb: string,
  params: unknown
) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

/** What the node's "update" verb answers inside the broker envelope's `data`. */
type UpdateResult = {
  ok?: boolean;
  error?: string;
  updating?: boolean;
  tag?: string;
  currentVersion?: string;
  reason?: string;
};

// ─── Error-to-status helper ───────────────────────────────────────────────────

/**
 * Map a node-side update failure onto a status.
 *
 * Same split every other broker-proxying route in the hub uses (node-posture,
 * station-cleanup, station-changeset, station-lifecycle): the node not being
 * reachable is a conflict with the fleet's current state and retryable as-is,
 * everything else is an upstream failure. 5xx stays reserved for "the hub
 * itself broke" only in the 500 sense — 502 explicitly says the failure came
 * from the node, not from here.
 */
function brokerErrorStatus(error: string | undefined): 409 | 502 {
  if (error === "node offline" || error === "node disconnected") return 409;
  return 502;
}

/**
 * Read the `force` flag from either `?force=1` (convenient from curl) or a
 * `{"force":true}` JSON body. An absent or unparseable body is not an error —
 * the console posts no body at all.
 */
async function readForce(c: {
  req: { query(k: string): string | undefined; json(): Promise<unknown> };
}): Promise<boolean> {
  const q = c.req.query("force");
  if (q === "1" || q === "true") return true;
  const body = await c.req.json().catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { force?: unknown }).force === true
  );
}

// ─── Factory (allows broker injection for unit tests) ─────────────────────────

/**
 * Create the authenticated node management routes.
 *
 * An optional `deps.request` override replaces the real broker so tests can
 * assert the RPC call without needing a live WebSocket connection.
 */
export function createNodeRoutes(deps?: {
  request?: RequestFn;
  /** Replaces the database-backed node list so the rollout is unit-testable. */
  listNodesFn?: (userId: string) => Promise<RolloutNode[]>;
}) {
  const _request: RequestFn = deps?.request ?? brokerRequest;
  const _listNodes = deps?.listNodesFn ?? (listNodes as (u: string) => Promise<RolloutNode[]>);

  return (
    new Hono()
      /**
       * GET /api/nodes → list nodes belonging to the current user.
       */
      .get("/", async (c) => c.json(await listNodes(c.get("user").id)))
      /**
       * POST /api/nodes/update-all  [body {"force"?:bool, "only"?:string[]}]
       *
       * Update the fleet, one node at a time, in name order (issue #295).
       *
       * Registered before `/:id/update` for readability only — the two cannot
       * collide, one is a single segment and the other is two.
       *
       * Always 200 with a row per node, including the ones it chose not to
       * touch. A rollout that reported only its successes would be the same
       * defect as the single-node route's old envelope: an operator reading
       * "ok" while machines sat on the old binary. `failed` here means a node
       * was asked and did not update; `skipped` means it was never asked, and
       * says why.
       */
      .post("/update-all", async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
          force?: unknown;
          only?: unknown;
        } | null;
        const force = body?.force === true;
        const only = Array.isArray(body?.only)
          ? (body.only as unknown[]).filter((x): x is string => typeof x === "string")
          : undefined;

        const nodes = await _listNodes(c.get("user").id);
        const plan = planRollout(nodes, { force, only });
        const results = await executeRollout(plan, { request: _request, force });

        return c.json({
          ok: true as const,
          summary: summarise(results),
          results,
        });
      })
      /**
       * POST /api/nodes/:id/update  [?force=1  |  body {"force":true}]
       *
       * Sends an "update" RPC to the node via the broker. When the node is
       * behind the latest release it self-updates in-process and exits so
       * systemd/Restart=always can bring it back on the new binary; when it is
       * already current it answers `updating:false` and stays up. `force`
       * re-applies the current release — the escape hatch for a corrupt binary.
       *
       * The status answers "did the update happen", not "did the WebSocket
       * round-trip happen" (issue #296). The route used to return the broker
       * envelope verbatim, so a node that refused the verb answered
       * `HTTP 200 {"ok":false,"error":"descriptor: unknown verb \"update\""}` —
       * success to any caller that checks the status, while the node did
       * nothing. That is a bad failure to hide, because the symptom of a
       * silently failed update is nothing at all: the node keeps running the
       * old binary and looks healthy.
       *
       *   200 { ok: true, updating: true,  tag, currentVersion }  — update started
       *   200 { ok: true, updating: false, tag, reason }          — already current, no restart
       *   409 { ok: false, error: "node offline" }                — not connected
       *   502 { ok: false, error: "<what the node said>" }        — node refused or failed
       *
       * The node's own error text is passed through rather than replaced with
       * status copy: `descriptor: unknown verb "update"` IS the diagnosis, and
       * the console surfaces a hub-supplied `error` field in its toast.
       */
      .post("/:id/update", async (c) => {
        const nodeId = c.req.param("id");
        const force = await readForce(c);
        const r = await _request(nodeId, "update", { force });

        // The RPC never reached the node, or the node rejected the frame.
        if (!r.ok) {
          return c.json(
            { ok: false as const, error: r.error ?? "update failed" },
            brokerErrorStatus(r.error)
          );
        }

        // The round-trip succeeded but the update itself did not — e.g. the
        // download 404'd or the checksum did not match. Same class of lie as
        // the envelope case if it were reported as 200.
        const data = (r.data ?? {}) as UpdateResult;
        if (data.ok === false) {
          return c.json(
            { ok: false as const, error: data.error ?? "update failed" },
            502
          );
        }

        // Flattened: the node's payload arrives nested under `data`, so a
        // caller reading `body.updating` off the envelope always saw undefined
        // and could not tell a started update from a no-op.
        return c.json({
          ok: true as const,
          updating: data.updating ?? false,
          tag: data.tag,
          currentVersion: data.currentVersion,
          reason: data.reason,
        });
      })
  );
}

/**
 * Authenticated routes for node management.
 * Mounted at /api/nodes (under the authMiddleware guard).
 */
export const nodeRoutes = createNodeRoutes();

/**
 * Public (unauthenticated) node enrollment route.
 * Mounted at /public/nodes (OUTSIDE the /api/* auth guard).
 *
 * POST /public/nodes/enroll
 *   Body: { token: string; hostInfo: HostInfo }
 *   Returns: { nodeId: string; nodeSecret: string }
 */
export const nodeEnrollRoutes = new Hono()
  .post(
    "/enroll",
    zValidator("json", EnrollRequest),
    async (c) => {
      const { token, hostInfo } = c.req.valid("json");
      try {
        return c.json(await enrollNode(token, hostInfo));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 401);
      }
    }
  )
  // Node-side credential probe (self-healing re-enroll, #161).
  // Auth: Authorization: Bearer <nodeId>:<nodeSecret> — same scheme as the gateway.
  // 200 {valid:true} when the stored credential is still valid on this hub;
  // 401 {valid:false} otherwise. No state change.
  .get("/credential-check", async (c) => {
    const auth = c.req.header("Authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/, "");
    const idx = token.indexOf(":");
    const nodeId = idx !== -1 ? token.slice(0, idx) : "";
    const nodeSecret = idx !== -1 ? token.slice(idx + 1) : "";
    if (!nodeId || !nodeSecret || !(await verifyNodeCredential(nodeId, nodeSecret))) {
      return c.json({ valid: false }, 401);
    }
    return c.json({ valid: true });
  });
