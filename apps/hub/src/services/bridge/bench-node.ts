/**
 * The hub's half of the node's registry verbs (`bench.registry.status|set|remove`).
 *
 * The node writes its own private registry and answers with what it now serves: the registry's
 * digest, each profile's exact target and its repositories' digests. The hub believes that reply
 * and nothing it computed itself, which is the point: `registry_sha256` is never typed by anyone.
 */
import { eq } from "drizzle-orm";
import {
  BENCH_REGISTRY_MANAGE_CAPABILITY,
  BENCH_REGISTRY_REMOVE_VERB,
  BENCH_REGISTRY_SET_VERB,
  BENCH_REGISTRY_STATUS_VERB,
  BenchRegistryStatus,
} from "@agentpod/contract";

import { db } from "../../db/drizzle";
import { nodes } from "../../db/schema/nodes";
import * as broker from "../broker";
import { connectionManager } from "../broker";

const NODE_TIMEOUT_MS = 20_000;

export type NodeAnswer =
  | { ok: true; status: BenchRegistryStatus }
  /** `soft`: the node could not be asked (offline, or too old), so nothing was attempted. */
  | { ok: false; soft: boolean; error: string };

/** The node half of one stage, as the node's Go `ProfileChange` reads it. */
export interface NodeProfileChange {
  id: string;
  tenant_id: string;
  board_id: string;
  agent_id: string;
  station_id: string;
  checkpoint_repository?: string;
  repositories?: { name: string; repository: string; base?: string; object_format: string }[];
  arguments?: string[];
  environment?: Record<string, string>;
  launch?: string;
}

export const NODE_TOO_OLD =
  "this node does not manage a bench registry from the hub; update it (fleet nodes update) and retry";

async function unaskable(nodeId: string): Promise<string | null> {
  if (!connectionManager.isOnline(nodeId)) return "node offline";
  const [row] = await db.select({ capabilities: nodes.capabilities }).from(nodes).where(eq(nodes.id, nodeId));
  const caps = row?.capabilities;
  return Array.isArray(caps) && caps.includes(BENCH_REGISTRY_MANAGE_CAPABILITY) ? null : NODE_TOO_OLD;
}

async function ask(nodeId: string, verb: string, params: unknown): Promise<NodeAnswer> {
  const why = await unaskable(nodeId);
  if (why) return { ok: false, soft: true, error: why };
  const res = await broker.request(nodeId, verb, params, { timeoutMs: NODE_TIMEOUT_MS });
  if (!res.ok) {
    const error = res.error ?? `${verb} failed`;
    return { ok: false, soft: error === "node offline" || error === "node disconnected", error };
  }
  const parsed = BenchRegistryStatus.safeParse(res.data);
  if (!parsed.success) return { ok: false, soft: false, error: "the node's answer was not a registry status" };
  return { ok: true, status: parsed.data };
}

export const nodeRegistryStatus = (nodeId: string) => ask(nodeId, BENCH_REGISTRY_STATUS_VERB, {});
export const nodeRegistrySet = (nodeId: string, profile: NodeProfileChange | undefined, repin: boolean) =>
  ask(nodeId, BENCH_REGISTRY_SET_VERB, { ...(profile ? { profile } : {}), ...(repin ? { repin: true } : {}) });
export const nodeRegistryRemove = (nodeId: string, id: string) => ask(nodeId, BENCH_REGISTRY_REMOVE_VERB, { id });
