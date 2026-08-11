/**
 * Seeds local kaambaan with a board, a two-stage pipeline, an agent (returning
 * its kbn_ bearer) and one card. Prints the two values the bridge needs.
 *
 * Deliberately does NOT use loadConfig() — it runs before BOARD_ID/AGENT_TOKEN
 * exist, which is the whole point of it.
 */

// tnt_dev / usr_dev are what `pnpm dev:setup` seeds into the local D1 catalog
// (kaambaan apps/api/scripts/seed-dev.sql). Anything else fails the tenant
// foreign key with an opaque D1_ERROR.
const BASE = process.env.KAAMBAAN_URL ?? "http://localhost:8787";
const TENANT = process.env.TENANT_ID ?? "tnt_dev";
const OWNER = process.env.OWNER_USER_ID ?? "usr_dev";
const dev = { "X-Tenant-Id": TENANT, "Content-Type": "application/json" };

const CARD_TITLE =
  process.env.CARD_TITLE ?? "Create hello.txt containing the word spike, then stop.";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: dev,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const board = await post<{ boardId: string }>("/v1/boards", {
  name: "Bridge spike",
  stages: [
    { key: "work", name: "Work", order: 0, ownerKind: "capability", owner: "acp" },
    { key: "done", name: "Done", order: 1, ownerKind: "human" },
  ],
});

const agent = await post<{ agent: { id: string }; token: string }>("/v1/agents", {
  name: "AgentPod fleet",
  capabilities: ["acp"],
});

const card = await post<{ cardId?: string; id?: string }>(
  `/v1/boards/${board.boardId}/cards`,
  { title: CARD_TITLE, ownerUserId: OWNER },
);

console.log(`BOARD_ID=${board.boardId}`);
console.log(`AGENT_TOKEN=${agent.token}`);
console.log(`# card: ${card.cardId ?? card.id ?? "(id not returned)"} — ${CARD_TITLE}`);
