/**
 * Waking a board's claim loops when the board says work is ready.
 *
 * A loop that finds nothing waits out its poll before it asks again. SuperPipeline pushes
 * `work.available` the moment a card it could hand out appears (created, advanced, released,
 * reclaimed or unblocked), but the bridge never subscribed, so a fresh card waited out the poll.
 * Now each roster row subscribes (`push-subscription.ts`), the signed receiver passes the board here
 * (`routes/superpipeline-push.ts`), and every idle loop on that board claims at once.
 *
 * The poll stays underneath as the floor: a lost push, a push that arrives mid-cycle, a board that
 * cannot reach this hub, a hub with no public URL. A wake only shortens a wait; it never decides
 * what is claimed, which stays the board's answer to the claim.
 */

type Wake = () => void;

const listeners = new Map<string, Set<Wake>>();

/** Run `wake` whenever `boardId` says work is ready. Returns the unsubscribe. */
export function onWorkAvailable(boardId: string, wake: Wake): () => void {
  let set = listeners.get(boardId);
  if (!set) {
    set = new Set();
    listeners.set(boardId, set);
  }
  set.add(wake);
  return () => {
    const current = listeners.get(boardId);
    if (!current) return;
    current.delete(wake);
    if (current.size === 0) listeners.delete(boardId);
  };
}

/** Wake every loop working `boardId`. Returns how many were woken. */
export function wakeBoard(boardId: string): number {
  const set = listeners.get(boardId);
  if (!set) return 0;
  // A copy, so a listener that unsubscribes while being woken does not skip its neighbour.
  const woken = Array.from(set);
  for (const wake of woken) wake();
  return woken.length;
}

/** The body SuperPipeline pushes for `work.available`: the board, the card and its stage. */
export interface WorkAvailableDelivery {
  event: "work.available";
  boardId: string;
  cardId?: string;
  stageKey?: string;
}

export function isWorkAvailable(body: unknown): body is WorkAvailableDelivery {
  if (typeof body !== "object" || body === null) return false;
  if (!("event" in body) || body.event !== "work.available") return false;
  return "boardId" in body && typeof body.boardId === "string" && body.boardId !== "";
}
