import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { EnrollRequest } from "@agentpod/contract";
import { enrollNode, verifyNodeCredential } from "../services/enrollment";
import { listNodes } from "../services/node-registry";
import { nodesWithFixedImage } from "../services/runtimes";
import {
  executeRollout,
  planRollout,
  summarise,
  type RolloutNode,
} from "../services/rollout";
import { request as brokerRequest } from "../services/broker";
import { isUserAdmin } from "../models/admin-users";
import { logAdminAction, type LogAdminActionInput } from "../models/admin-audit-log";
import { createLogger } from "../utils/logger";

const log = createLogger("nodes-routes");

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

// ─── Telemetry helpers ────────────────────────────────────────────────────────

type TelemetryStatus = "changed" | "unchanged" | "ok" | "unsupported" | "offline" | "failed";

type TelemetryRow = {
  nodeId: string;
  name: string;
  status: TelemetryStatus;
  endpoint?: string;
  enabled?: boolean;
  restarting?: boolean;
  /** The endpoint the node process is exporting to now (status only). */
  effective?: string;
  error?: string;
};

/** What the node's telemetry.status / telemetry.set verbs answer in `data`. */
type TelemetryData = {
  ok?: boolean;
  unsupported?: boolean;
  error?: string;
  endpoint?: string;
  enabled?: boolean;
  changed?: boolean;
  restarting?: boolean;
  effective?: string;
};

/**
 * Hub-side mirror of the node's otelenv.ValidateEndpoint, so a bad endpoint is a
 * 400 here instead of a per-node failure: http(s) with a host; no whitespace,
 * control or non-ASCII characters; none of = " ' ` \ $ # (they would change
 * the meaning of the env-file line); no embedded credentials.
 */
const TELEMETRY_ENDPOINT_RULES =
  "endpoint must be an http(s) URL with a host and no whitespace, control or non-ASCII characters, " +
  "none of = \" ' ` \\ $ #, and no embedded credentials";

function validTelemetryEndpoint(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0) return false;
  for (const ch of v) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || code >= 0x7f) return false;
    if ("=\"'`\\$#".includes(ch)) return false;
  }
  try {
    const u = new URL(v);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.hostname !== "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

/** The fixed-image answer: such a node has no supervisor to restart it (#349). */
const FIXED_IMAGE_TELEMETRY =
  "node boots from a fixed image; telemetry is configured in the image/substrate";

function countBy(rows: TelemetryRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

/**
 * Ask one online node a telemetry verb and normalise every way that can go
 * wrong onto the status vocabulary. `unknown verb` means the node predates the
 * feature, which is an instruction to the operator, not a failure of the node.
 */
async function askTelemetry(
  request: RequestFn,
  node: RolloutNode,
  verb: "telemetry.status" | "telemetry.set",
  params: unknown
): Promise<TelemetryRow> {
  const base = { nodeId: node.id, name: node.name };
  const unsupported = (error: string): TelemetryRow => ({ ...base, status: "unsupported", error });
  let r: Awaited<ReturnType<RequestFn>>;
  try {
    r = await request(node.id, verb, params);
  } catch (e) {
    return { ...base, status: "failed", error: (e as Error).message };
  }
  if (!r.ok) {
    const err = r.error ?? "request failed";
    if (err.includes("unknown verb")) {
      return unsupported(
        `node ${node.agentVersion ?? "(unknown version)"} predates telemetry config; run \`fleet nodes update\``
      );
    }
    if (err === "node offline" || err === "node disconnected") return { ...base, status: "offline", error: err };
    return { ...base, status: "failed", error: err };
  }
  const d = (r.data ?? {}) as TelemetryData;
  if (d.unsupported) return unsupported(d.error ?? "telemetry config is not supported on this node");
  if (d.ok === false) return { ...base, status: "failed", error: d.error ?? "telemetry request failed" };
  const status: TelemetryStatus =
    verb === "telemetry.status" ? "ok" : d.changed ? "changed" : "unchanged";
  const row: TelemetryRow = { ...base, status, endpoint: d.endpoint, enabled: d.enabled };
  if (verb === "telemetry.set") row.restarting = d.restarting === true;
  if (typeof d.effective === "string") row.effective = d.effective;
  return row;
}

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
  /** Replaces the runtime lookup that answers which nodes boot from an image. */
  fixedImageNodesFn?: (userId: string) => Promise<Set<string>>;
  /** Replaces the database-backed admin check (telemetry routes are admin-only). */
  isAdminFn?: (userId: string) => Promise<boolean>;
  /** Replaces the audit-log writer. */
  auditFn?: (entry: LogAdminActionInput) => Promise<unknown>;
}) {
  const _request: RequestFn = deps?.request ?? brokerRequest;
  const _listNodes = deps?.listNodesFn ?? (listNodes as (u: string) => Promise<RolloutNode[]>);
  const _fixedImageNodes = deps?.fixedImageNodesFn ?? nodesWithFixedImage;
  const _isAdmin = deps?.isAdminFn ?? isUserAdmin;
  const _audit = deps?.auditFn ?? logAdminAction;

  return (
    new Hono()
      /**
       * GET /api/nodes → list nodes belonging to the current user.
       */
      .get("/", async (c) => c.json(await listNodes(c.get("user").id)))
      /**
       * GET /api/nodes/telemetry  (admin only)
       *
       * Fans out `telemetry.status` to every online node. Always 200 with a row
       * per node: `ok | unsupported | offline | failed`. A fixed-image node is
       * answered `unsupported` by the hub without being asked (#349).
       */
      .get("/telemetry", async (c) => {
        const userId = c.get("user").id;
        if (!(await _isAdmin(userId))) {
          return c.json({ ok: false as const, error: "Forbidden: Admin access required" }, 403);
        }
        const nodes = (await _listNodes(userId)).slice().sort((a, b) => a.name.localeCompare(b.name));
        const fixed = await _fixedImageNodes(userId);
        const results: TelemetryRow[] = [];
        for (const n of nodes) {
          results.push(
            fixed.has(n.id)
              ? { nodeId: n.id, name: n.name, status: "unsupported", error: FIXED_IMAGE_TELEMETRY }
              : n.status !== "online"
                ? { nodeId: n.id, name: n.name, status: "offline" }
                : await askTelemetry(_request, n, "telemetry.status", {})
          );
        }
        return c.json({ ok: true as const, summary: countBy(results), results });
      })
      /**
       * POST /api/nodes/telemetry  (admin only)
       * Body: exactly one of {"endpoint":"<http(s) url>"} / {"off":true},
       * optional "only": string[] of node names or ids.
       *
       * Sequential `telemetry.set` per online node. Every node that was
       * actually asked (anything but offline) gets one audit entry; an audit
       * write failure is logged and never hides the node result. Fixed-image
       * nodes are never asked: the node would write a file nothing reads and
       * exit, which stops a container station (#349). They are reported
       * `unsupported` and not audited.
       */
      .post("/telemetry", async (c) => {
        const user = c.get("user");
        if (!(await _isAdmin(user.id))) {
          return c.json({ ok: false as const, error: "Forbidden: Admin access required" }, 403);
        }
        const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
        const bad = (error: string) => c.json({ ok: false as const, error }, 400);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return bad("body must be a JSON object");
        }
        const hasEndpoint = body.endpoint !== undefined;
        const hasOff = body.off !== undefined;
        if (hasEndpoint === hasOff) return bad('provide exactly one of "endpoint" or "off":true');
        if (hasOff && body.off !== true) return bad('"off" must be true');
        if (hasEndpoint && !validTelemetryEndpoint(body.endpoint)) {
          return bad(TELEMETRY_ENDPOINT_RULES);
        }
        let only: string[] | undefined;
        if (body.only !== undefined) {
          if (!Array.isArray(body.only) || !body.only.every((x) => typeof x === "string")) {
            return bad('"only" must be an array of node names or ids');
          }
          only = body.only as string[];
        }

        const all = await _listNodes(user.id);
        let targets = all;
        if (only) {
          const unknown = only.filter((o) => !all.some((n) => n.id === o || n.name === o));
          if (unknown.length > 0) return bad(`unknown node(s): ${unknown.join(", ")}`);
          const want = new Set(only);
          targets = all.filter((n) => want.has(n.id) || want.has(n.name));
        }
        targets = targets.slice().sort((a, b) => a.name.localeCompare(b.name));

        const params = hasOff ? { off: true } : { endpoint: body.endpoint as string };
        const fixed = await _fixedImageNodes(user.id);
        const results: TelemetryRow[] = [];
        for (const n of targets) {
          if (fixed.has(n.id)) {
            results.push({ nodeId: n.id, name: n.name, status: "unsupported", error: FIXED_IMAGE_TELEMETRY });
            continue;
          }
          if (n.status !== "online") {
            results.push({ nodeId: n.id, name: n.name, status: "offline" });
            continue;
          }
          const row = await askTelemetry(_request, n, "telemetry.set", params);
          results.push(row);
          if (row.status === "offline") continue;
          try {
            await _audit({
              adminUserId: user.id,
              action: "node_telemetry_update",
              targetResourceType: "node",
              targetResourceId: n.id,
              details: {
                ...params,
                status: row.status,
                ...(row.error ? { error: row.error } : {}),
              },
            });
          } catch (e) {
            log.error("Failed to write node_telemetry_update audit entry", {
              nodeId: n.id,
              error: (e as Error).message,
            });
          }
        }
        return c.json({ ok: true as const, summary: countBy(results), results });
      })
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

        const userId = c.get("user").id;
        const nodes = await _listNodes(userId);

        // A node whose binary comes from an image is not updatable by RPC, and
        // asking stops it. A rollout that did that to every container station
        // would be far worse than one that updates nothing (#349).
        const fixed = await _fixedImageNodes(userId);
        const plan = planRollout(
          nodes.map((n) => ({ ...n, imageFixed: fixed.has(n.id) })),
          { force, only }
        );
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

        // Refused BEFORE the RPC, because sending it is what stops the station:
        // the agent swaps its binary and exits for a supervisor that a
        // container substrate does not have, onto a disk that will not keep the
        // swap (#349). `force` does not apply — it cannot make this work.
        if ((await _fixedImageNodes(c.get("user").id)).has(nodeId)) {
          return c.json(
            {
              ok: false as const,
              error:
                "This node's binary comes from the substrate's image, so it cannot " +
                "self-update — the attempt would stop the station and change nothing. " +
                "Bump AGENTPOD_VERSION in that image, redeploy it, then restart the " +
                "runtime; the workspace is restored from its archive.",
            },
            409
          );
        }

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
