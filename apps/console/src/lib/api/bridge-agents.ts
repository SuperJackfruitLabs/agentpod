/**
 * The superpipeline bridge's roster, over the admin API.
 *
 * Until this existed the roster was `SUPERPIPELINE_BRIDGE_AGENTS` — a JSON array in `hub.env` —
 * so adding an agent or rotating its credential meant root on the hub host and a restart, while
 * everything else in AgentPod is a row a human creates here. A control that awkward is one people
 * route around, which is the same argument the grants client above it makes.
 *
 * **Nothing here can read a credential back.** The hub answers `hasToken` and `hasMcpToken`; there
 * is no field to ask for more, and a write replies in the same shape rather than echoing what it
 * was sent. A token can be replaced and never inspected, which is the only honest thing to offer
 * for a value that is stored encrypted.
 */

import { http } from "./client";

export interface BridgeAgent {
  /** Stable name. Lands in `bridge_dispatches.agent_key` and in every hub log line. */
  key: string;
  /** superpipeline's board, `brd_<16 hex>`. */
  boardId: string;
  stationId: string;
  /** The station's display name, so the list is not a column of opaque ids. */
  stationName: string | null;
  /**
   * Read from the station, not stored on the roster: ACP sessions are authorized by user id, and
   * an agent naming anyone but its station's owner failed every call as "Station not found".
   */
  hubUserId: string;
  mode: "ask" | "accept-edits" | "full-auto";
  permissionWaitMs: number | null;
  maxConcurrency: number | null;
  profileKey: string | null;
  /** Disabled entries keep their credentials and stop being claimed with. */
  enabled: boolean;
  hasToken: boolean;
  /** Whether this agent can report on its own card over MCP. */
  hasMcpToken: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeAgentInput {
  key: string;
  boardId: string;
  stationId: string;
  token: string;
  /**
   * The second credential, which the HARNESS spends. Mint it **run-scoped** in superpipeline
   * (Workspace → Agents → "Issue a run-only token"): the `token` above can claim, and an agent
   * holding that could take a second card while still working the first.
   */
  mcpToken?: string | null;
  mode?: BridgeAgent["mode"];
  permissionWaitMs?: number | null;
  maxConcurrency?: number | null;
  profileKey?: string | null;
  enabled?: boolean;
}

export type BridgeAgentPatch = Partial<Omit<BridgeAgentInput, "key">>;

export const listBridgeAgents = () =>
  http<{ agents: BridgeAgent[] }>("/api/admin/bridge/agents").then((r) => r.agents);

export const createBridgeAgent = (input: BridgeAgentInput) =>
  http<{ agent: BridgeAgent }>("/api/admin/bridge/agents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => r.agent);

export const updateBridgeAgent = (key: string, patch: BridgeAgentPatch) =>
  http<{ agent: BridgeAgent }>(`/api/admin/bridge/agents/${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => r.agent);

export const deleteBridgeAgent = (key: string) =>
  http<{ removed: boolean }>(`/api/admin/bridge/agents/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
