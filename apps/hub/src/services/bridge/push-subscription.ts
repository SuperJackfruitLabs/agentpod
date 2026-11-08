/**
 * Subscribe each board this hub works to the hub's signed push route.
 *
 * `POST /public/bridge/superpipeline/push` projects a gate or an agent's question into its room the
 * moment it opens — but only if the board knows to call it, and a board knows only through a push
 * config registered with it. The approvals-over-chat design (§5.6) said "register the push config,
 * and script it so a rebuild does not silently lose the subscription". It was never done: no
 * production board had a config, its delivery queue stayed empty, and every gate reached Matrix on
 * the five-minute sweep instead of in seconds.
 *
 * So the hub registers it itself, with each board's own credential, on start and again on every
 * sweep. Registration is an upsert on (agent, url) in superpipeline, so refreshing is free and it
 * repairs a board rebuilt, a secret rotated, or a board added to the roster at noon.
 *
 * The config's `token` is the HMAC key superpipeline signs each delivery with — the hub's
 * `SUPERPIPELINE_PUSH_SECRET`, never the agent's credential.
 */

import { SuperpipelineApiError, SuperpipelineClient, type Fetcher } from "./superpipeline";

/**
 * The events the push route projects; anything else it acknowledges and ignores. `delivery.pending`
 * is the follow-up a manual-delivery approval owes (charter: "The decision envelope covers
 * questions and follow-ups" §3); `attention.pending` a card waiting on a person (charter: "Waiting
 * cards and broker approvals reach chat" §1); `decision.reminded` / `decision.escalated` a decision that
 * passed its stage's timeout.
 */
export const PUSH_EVENTS = [
  "gate.pending",
  "elicitation.pending",
  "delivery.pending",
  "attention.pending",
  // A waiting decision passed its stage's timeout (charter: "Unanswered decisions remind, then
  // escalate" §2): the hub replies to the card it posted, and on escalation invites the admins.
  "decision.reminded",
  "decision.escalated",
] as const;

export function pushHookUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/public/bridge/superpipeline/push`;
}

export interface SubscribeOptions {
  baseUrl: string;
  /** This hub's public origin — where superpipeline must be able to reach the push route. */
  publicUrl: string;
  /** `SUPERPIPELINE_PUSH_SECRET`. Unset means the route refuses every push, so nothing is registered. */
  secret: string | undefined;
  fetch: Fetcher;
  /** Board → the credential to register it with (the same one the sweep reads it with). */
  boards: () => Promise<Map<string, string>>;
  /**
   * The relay token for a board (`relay.ts`), or null when the board is not the relay's workspace or
   * there is no relay. With one, the board also gets a push config registered by the relay service
   * for `elicitation.pending` — the one event SuperToolkit approval requests ride, and which the
   * board sends them on only to a service-registered config.
   */
  relayTokenFor?: (boardId: string) => Promise<string | null>;
  /** SuperPipeline refused the relay's token (401/403): the relay forgets it. */
  onRelayRefused?: () => void;
}

/**
 * What the relay subscribes to. Only `elicitation.pending`: the other decision events already reach
 * the hub through the agent's config, and subscribing the relay to them too would deliver each twice.
 */
export const RELAY_PUSH_EVENTS = ["elicitation.pending"] as const;

export interface SubscribeResult {
  subscribed: string[];
  /** Boards that also have the relay's `elicitation.pending` config. */
  relayed: string[];
  failed: Array<{ boardId: string; error: string }>;
}

export async function subscribeBoardsToPush(opts: SubscribeOptions): Promise<SubscribeResult> {
  const result: SubscribeResult = { subscribed: [], relayed: [], failed: [] };
  if (!opts.secret) return result;

  const url = pushHookUrl(opts.publicUrl);
  for (const [boardId, token] of await opts.boards()) {
    try {
      await new SuperpipelineClient({ baseUrl: opts.baseUrl, boardId, token, fetch: opts.fetch }).registerPushConfig({
        url,
        token: opts.secret,
        events: [...PUSH_EVENTS],
      });
      result.subscribed.push(boardId);
    } catch (err) {
      // One board refusing must not leave the others unsubscribed.
      result.failed.push({ boardId, error: err instanceof Error ? err.message : String(err) });
    }
    if (!opts.relayTokenFor) continue;
    try {
      const relayToken = await opts.relayTokenFor(boardId);
      if (!relayToken) continue;
      // A plane-minted service token, not an agent's `spa_`: carried as the client's resolved credential.
      await new SuperpipelineClient({ baseUrl: opts.baseUrl, boardId, token: "", credential: async () => relayToken, fetch: opts.fetch }).registerPushConfig({
        url,
        token: opts.secret,
        events: [...RELAY_PUSH_EVENTS],
      });
      result.relayed.push(boardId);
    } catch (err) {
      if (err instanceof SuperpipelineApiError && (err.status === 401 || err.status === 403)) opts.onRelayRefused?.();
      result.failed.push({ boardId, error: `relay: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return result;
}
