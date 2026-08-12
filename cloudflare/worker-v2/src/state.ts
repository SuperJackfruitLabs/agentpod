/**
 * What state a sandbox's container is actually in.
 *
 * The hub may only write `stopped` for a runtime on evidence that the container
 * is down, because an operator reads `stopped` as "this has stopped costing me
 * money". Nothing on the hub's side can supply that evidence: a node going
 * offline proves nothing (nodes drop for network reasons while their container
 * runs on, and bills). Only the substrate knows, so the substrate is asked —
 * and this module is Cloudflare's answer.
 *
 * `unknown` is a real answer here, not an error. A container this worker cannot
 * see must be reported as unseen; the hub keeps asking and eventually tells the
 * operator the stop was never confirmed. That is a far better outcome than a
 * confident "stopped" over a container that is still running.
 */

export type ContainerState = "running" | "stopped" | "unknown";

/**
 * DO storage key for the last observed lifecycle transition.
 *
 * Only a fallback: `ctx.container.running` is the live truth. This exists for
 * the case where there is no container binding to ask at all.
 */
export const STATE_KEY = "lifecycleState";

/** What onStart / onStop record. */
export interface LifecycleRecord {
  state: "running" | "stopped";
  at: string;
  exitCode?: number;
  reason?: string;
}

/** Anything that is not one of the two definite answers is `unknown`. */
export function asState(value: unknown): ContainerState {
  return value === "running" || value === "stopped" ? value : "unknown";
}

function recordedState(recorded: unknown): ContainerState {
  if (!recorded || typeof recorded !== "object") return "unknown";
  return asState((recorded as { state?: unknown }).state);
}

/**
 * Resolve the container's state, preferring the runtime's live view.
 *
 * `running` comes from `ctx.container.running` — the runtime itself, not our
 * bookkeeping — so it wins over any record, however recent. The record answers
 * only when there is no container binding to consult.
 */
export function deriveState(
  running: boolean | undefined,
  recorded: unknown
): ContainerState {
  if (running === true) return "running";
  if (running === false) return "stopped";
  return recordedState(recorded);
}

/** Injected so the route is testable without a Durable Object. */
export interface StatusDeps {
  /** The container's state, as the Durable Object derived it. */
  state(): Promise<unknown>;
}

/**
 * GET /sandbox/:id — the sandbox's id and what its container is doing.
 *
 * Additive: the response still carries `sandboxId`, which is all this route
 * used to return, so nothing that read the old shape breaks. A hub talking to a
 * worker deployed before this change simply sees no `state` and reads that as
 * `unknown` — which is exactly right, and why it is safe to ship the hub side
 * ahead of the deploy.
 */
export async function handleStatus(
  id: string,
  deps: StatusDeps
): Promise<Response> {
  let state: ContainerState = "unknown";
  try {
    state = asState(await deps.state());
  } catch (e) {
    // A failure to read is not evidence of anything, and `unknown` is a state
    // the hub handles properly. A 500 here would be indistinguishable from a
    // worker that has not been redeployed — a worse thing to be confused with.
    console.log("[agentpod] container state unreadable", String(e));
  }

  return Response.json({ sandboxId: id, state });
}
