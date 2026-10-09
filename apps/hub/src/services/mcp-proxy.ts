/**
 * Which stations each node's loopback MCP proxy serves — the hub side of `fleet mcp-proxy`.
 *
 * **Two facts, compared.** The node's own config (`mcpProxy.stations`) is what it SERVES, asked
 * live with `mcp.proxy.status`; `stations.mcp_proxy` is what an operator DECLARED through here
 * (null = nobody has). They disagreeing — a hand edit, a reset config — is drift, reported, never
 * silently "fixed": nothing here writes to a node except an operator's explicit change.
 *
 * **A hand-edited config migrates with no step.** With nothing declared, whatever the node serves
 * stands and reads as `on`, not as drift; declaring is what `enable`/`disable` do.
 *
 * **Refused before the node is asked:** a station on a harness whose ACP adapter takes no HTTP MCP
 * servers in `session/new` (OpenClaw, Pi — see `MCP_PROXY_HARNESSES`). Serving one would hand out
 * a URL no session of it can use.
 *
 * Every change and rotation writes a `station_audit` row before the node is asked, finalised with
 * the outcome. No secret ever moves: the node generates and keeps them, and answers with ids.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  McpProxySetResult,
  McpProxyStatusResult,
  McpProxyRotateResult,
  mcpProxyEligible,
  type McpProxyChangeOutcome,
  type McpProxyChangeRequest,
  type McpProxyFleetView,
  type McpProxyNodeView,
  type McpProxyRotateRequest,
  type McpProxyStationState,
  type McpProxyStationView,
} from "@agentpod/contract";

import { db } from "../db/drizzle";
import { nodes } from "../db/schema/nodes";
import { stations } from "../db/schema/stations";
import { tenantScope } from "../db/tenant-scope";
import { resolveTenantForUser } from "../auth/tenant";
import { recordAudit } from "./audit";
import * as broker from "./broker";
import { connectionManager } from "./connection-manager";
import type { StationRow } from "./station-registry";

/** The node capability that says it answers `mcp.proxy.status|set|rotate`. */
export const MANAGE_CAPABILITY = "mcp.proxy.manage";

const NODE_TIMEOUT_MS = 15_000;

const NOT_MANAGED =
  "this node does not manage its MCP proxy from the hub; update it (fleet nodes update) and retry";

export interface ServiceResult {
  status: 200 | 404 | 409 | 422 | 502;
  body: unknown;
}

// ─── reading ─────────────────────────────────────────────────────────────────

export function stationState(
  declared: boolean | null,
  serving: boolean | null,
  eligible: boolean,
): McpProxyStationState {
  if (serving === null) return "unknown";
  if (serving && !eligible) return "ineffective";
  if (declared === true && !serving) return "drifted";
  if (declared === false && serving) return "drifted";
  return serving ? "on" : "off";
}

async function nodeManages(nodeId: string): Promise<boolean> {
  const [row] = await db.select({ capabilities: nodes.capabilities }).from(nodes).where(eq(nodes.id, nodeId));
  const caps = row?.capabilities;
  return Array.isArray(caps) && caps.includes(MANAGE_CAPABILITY);
}

/** Why a node cannot be asked right now, or null when it can. */
async function unaskable(nodeId: string): Promise<string | null> {
  if (!connectionManager.isOnline(nodeId)) return "node offline";
  if (!(await nodeManages(nodeId))) return NOT_MANAGED;
  return null;
}

async function servedBy(nodeId: string): Promise<{ stations: string[] } | { reason: string }> {
  const why = await unaskable(nodeId);
  if (why) return { reason: why };
  const res = await broker.request(nodeId, "mcp.proxy.status", {}, { timeoutMs: NODE_TIMEOUT_MS });
  if (!res.ok) return { reason: res.error ?? "mcp.proxy.status failed" };
  const parsed = McpProxyStatusResult.safeParse(res.data);
  if (!parsed.success) return { reason: "the node's answer was not a proxy status" };
  return { stations: parsed.data.stations };
}

function stationView(s: StationRow, served: Set<string> | null): McpProxyStationView {
  const eligible = mcpProxyEligible(s.harness);
  const serving = served ? served.has(s.id) : null;
  return {
    stationId: s.id,
    stationKey: s.stationKey,
    displayName: s.displayName,
    harness: s.harness,
    eligible,
    declared: s.mcpProxy ?? null,
    serving,
    state: stationState(s.mcpProxy ?? null, serving, eligible),
  };
}

async function ownedStations(userId: string, nodeId?: string): Promise<StationRow[]> {
  const tenantId = await resolveTenantForUser(userId);
  return db
    .select()
    .from(stations)
    .where(
      nodeId
        ? tenantScope(stations, tenantId, eq(stations.userId, userId), eq(stations.nodeId, nodeId))
        : tenantScope(stations, tenantId, eq(stations.userId, userId)),
    );
}

export async function fleetView(userId: string, nodeId?: string): Promise<McpProxyFleetView> {
  const tenantId = await resolveTenantForUser(userId);
  const nodeRows = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(
      nodeId
        ? tenantScope(nodes, tenantId, eq(nodes.userId, userId), eq(nodes.id, nodeId))
        : tenantScope(nodes, tenantId, eq(nodes.userId, userId)),
    );
  const all = await ownedStations(userId, nodeId);

  const views: McpProxyNodeView[] = await Promise.all(
    nodeRows.map(async (n) => {
      const mine = all.filter((s) => s.nodeId === n.id);
      const answer = await servedBy(n.id);
      if ("reason" in answer) {
        return {
          nodeId: n.id,
          nodeName: n.name,
          reachable: false,
          reason: answer.reason,
          stations: mine.map((s) => stationView(s, null)),
          unadoptedStations: [],
        };
      }
      const served = new Set(answer.stations);
      const adopted = new Set(mine.map((s) => s.id));
      return {
        nodeId: n.id,
        nodeName: n.name,
        reachable: true,
        stations: mine.map((s) => stationView(s, served)),
        unadoptedStations: answer.stations.filter((id) => !adopted.has(id)).sort(),
      };
    }),
  );
  views.sort((a, b) => a.nodeName.localeCompare(b.nodeName));
  for (const v of views) v.stations.sort((a, b) => a.stationKey.localeCompare(b.stationKey));

  let drifted = 0;
  for (const v of views) {
    drifted += v.unadoptedStations.length;
    drifted += v.stations.filter((s) => s.state === "drifted" || s.state === "ineffective").length;
  }
  return { nodes: views, drifted };
}

export async function oneStation(userId: string, stationId: string): Promise<McpProxyStationView | null> {
  const [s] = await db
    .select()
    .from(stations)
    .where(and(eq(stations.id, stationId), eq(stations.userId, userId)));
  if (!s) return null;
  const answer = await servedBy(s.nodeId);
  return stationView(s, "reason" in answer ? null : new Set(answer.stations));
}

// ─── changing ────────────────────────────────────────────────────────────────

async function namedStations(userId: string, ids: string[]): Promise<{ found: StationRow[]; missing: string[] }> {
  const unique = [...new Set(ids)];
  const rows = await db
    .select()
    .from(stations)
    .where(and(inArray(stations.id, unique), eq(stations.userId, userId)));
  const have = new Set(rows.map((r) => r.id));
  return { found: rows, missing: unique.filter((id) => !have.has(id)) };
}

function byNode(rows: StationRow[]): Map<string, StationRow[]> {
  const out = new Map<string, StationRow[]>();
  for (const r of rows) out.set(r.nodeId, [...(out.get(r.nodeId) ?? []), r]);
  return out;
}

/** 200 when every station succeeded; 409 when every failure was a node that could not be asked. */
function statusFor(results: McpProxyChangeOutcome[], hardFailures: number): 200 | 409 | 502 {
  if (results.every((r) => r.ok)) return 200;
  return hardFailures > 0 ? 502 : 409;
}

export async function changeProxy(userId: string, req: McpProxyChangeRequest): Promise<ServiceResult> {
  let targets: StationRow[];
  let skipped: { stationId: string; harness: string }[] | undefined;

  if (req.stationIds) {
    const { found, missing } = await namedStations(userId, req.stationIds);
    if (missing.length > 0) {
      return { status: 404, body: { error: "no such station", missing } };
    }
    targets = req.nodeId ? found.filter((s) => s.nodeId === req.nodeId) : found;
    if (req.action === "enable") {
      const refused = targets
        .filter((s) => !mcpProxyEligible(s.harness))
        .map((s) => ({ stationId: s.id, harness: s.harness }));
      if (refused.length > 0) {
        const harnesses = [...new Set(refused.map((r) => r.harness))].join(", ");
        return {
          status: 422,
          body: {
            error:
              `refused: ${harnesses} cannot use the MCP proxy — its ACP adapter does not accept HTTP MCP ` +
              "servers in session/new, so its sessions would never get the tools. Nothing was changed.",
            refused,
          },
        };
      }
    }
  } else {
    const all = await ownedStations(userId, req.nodeId);
    targets = all.filter((s) => mcpProxyEligible(s.harness));
    skipped = all
      .filter((s) => !mcpProxyEligible(s.harness))
      .map((s) => ({ stationId: s.id, harness: s.harness }));
  }

  const verb = req.action === "enable" ? "mcp.proxy.enable" : "mcp.proxy.disable";
  const results: McpProxyChangeOutcome[] = [];
  let hardFailures = 0;

  for (const [nodeId, group] of byNode(targets)) {
    // Audited before the node is asked: the change reaches an agent's tools, and must leave a
    // record even when it then fails.
    const audits = await Promise.all(
      group.map((s) =>
        recordAudit(db, { userId, nodeId, stationKey: s.stationKey, verb, params: { action: req.action } }),
      ),
    );
    const fail = async (error: string, hard: boolean) => {
      if (hard) hardFailures += group.length;
      await Promise.all(audits.map((a) => a.done("error", error).catch(() => {})));
      for (const s of group) results.push({ stationId: s.id, nodeId, ok: false, error });
    };

    const why = await unaskable(nodeId);
    if (why) {
      await fail(why, false);
      continue;
    }
    const ids = group.map((s) => s.id);
    const res = await broker.request(
      nodeId,
      "mcp.proxy.set",
      req.action === "enable" ? { enable: ids } : { disable: ids },
      { timeoutMs: NODE_TIMEOUT_MS },
    );
    if (!res.ok) {
      const offline = res.error === "node offline" || res.error === "node disconnected";
      await fail(res.error ?? "mcp.proxy.set failed", !offline);
      continue;
    }
    const parsed = McpProxySetResult.safeParse(res.data);
    if (!parsed.success) {
      await fail("the node's answer was not a station list", true);
      continue;
    }
    // Believed only where the node's own answer agrees: the declaration records what was done.
    const served = new Set(parsed.data.stations);
    const want = req.action === "enable";
    const done = group.filter((s) => served.has(s.id) === want);
    const notDone = group.filter((s) => served.has(s.id) !== want);
    if (done.length > 0) {
      await db
        .update(stations)
        .set({ mcpProxy: want })
        .where(inArray(stations.id, done.map((s) => s.id)));
    }
    for (const s of group) {
      const audit = audits[group.indexOf(s)]!;
      if (notDone.includes(s)) {
        hardFailures++;
        const error = `the node still ${want ? "does not serve" : "serves"} this station`;
        await audit.done("error", error).catch(() => {});
        results.push({ stationId: s.id, nodeId, ok: false, error });
      } else {
        await audit.done("ok").catch(() => {});
        results.push({ stationId: s.id, nodeId, ok: true });
      }
    }
  }

  const body: Record<string, unknown> = { results };
  if (skipped) body.skipped = skipped;
  return { status: statusFor(results, hardFailures), body };
}

export async function rotateProxy(userId: string, req: McpProxyRotateRequest): Promise<ServiceResult> {
  const results: McpProxyChangeOutcome[] = [];
  let hardFailures = 0;

  if (req.nodeId) {
    const tenantId = await resolveTenantForUser(userId);
    const [node] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(tenantScope(nodes, tenantId, eq(nodes.userId, userId), eq(nodes.id, req.nodeId)));
    if (!node) return { status: 404, body: { error: "no such node" } };
    const audit = await recordAudit(db, { userId, nodeId: node.id, stationKey: "", verb: "mcp.proxy.rotate", params: {} });
    const why = await unaskable(node.id);
    const res = why ? { ok: false as const, error: why } : await broker.request(node.id, "mcp.proxy.rotate", {}, { timeoutMs: NODE_TIMEOUT_MS });
    const parsed = res.ok ? McpProxyRotateResult.safeParse(res.data) : null;
    if (!res.ok || !parsed?.success) {
      const error = (!res.ok && res.error) || "the node's answer was not a rotation";
      await audit.done("error", error).catch(() => {});
      const soft = Boolean(why) || error === "node offline" || error === "node disconnected";
      return { status: soft ? 409 : 502, body: { error, results: [] } };
    }
    await audit.done("ok").catch(() => {});
    return {
      status: 200,
      body: { results: parsed.data.rotated.map((stationId) => ({ stationId, nodeId: node.id, ok: true })) },
    };
  }

  const { found, missing } = await namedStations(userId, req.stationIds!);
  if (missing.length > 0) return { status: 404, body: { error: "no such station", missing } };

  for (const [nodeId, group] of byNode(found)) {
    const audits = await Promise.all(
      group.map((s) => recordAudit(db, { userId, nodeId, stationKey: s.stationKey, verb: "mcp.proxy.rotate", params: {} })),
    );
    const why = await unaskable(nodeId);
    const res = why
      ? { ok: false as const, error: why }
      : await broker.request(nodeId, "mcp.proxy.rotate", { stations: group.map((s) => s.id) }, { timeoutMs: NODE_TIMEOUT_MS });
    const parsed = res.ok ? McpProxyRotateResult.safeParse(res.data) : null;
    const rotated = new Set(parsed?.success ? parsed.data.rotated : []);
    const soft = Boolean(why) || (!res.ok && (res.error === "node offline" || res.error === "node disconnected"));
    for (const [i, s] of group.entries()) {
      if (rotated.has(s.id)) {
        await audits[i]!.done("ok").catch(() => {});
        results.push({ stationId: s.id, nodeId, ok: true });
        continue;
      }
      const error = !res.ok
        ? (res.error ?? "mcp.proxy.rotate failed")
        : "the node's proxy does not serve this station; nothing to rotate";
      if (!soft && !res.ok) hardFailures++;
      await audits[i]!.done("error", error).catch(() => {});
      results.push({ stationId: s.id, nodeId, ok: false, error });
    }
  }
  return { status: statusFor(results, hardFailures), body: { results } };
}
