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

import { SuperpipelineClient, type Fetcher } from "./superpipeline";

/** The two events the push route projects; anything else it acknowledges and ignores. */
export const PUSH_EVENTS = ["gate.pending", "elicitation.pending"] as const;

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
}

export interface SubscribeResult {
  subscribed: string[];
  failed: Array<{ boardId: string; error: string }>;
}

export async function subscribeBoardsToPush(opts: SubscribeOptions): Promise<SubscribeResult> {
  const result: SubscribeResult = { subscribed: [], failed: [] };
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
  }
  return result;
}
