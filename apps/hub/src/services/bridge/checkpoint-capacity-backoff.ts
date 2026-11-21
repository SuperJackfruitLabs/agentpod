/**
 * How long a station waits after SuperBench refused a card for capacity.
 *
 * A `capacity_exhausted` refusal releases the card without penalty (checkpoint-refusal.ts), and the
 * board makes it claimable again at once. The next claim cycle took it straight back: one card reached
 * 24 attempts in minutes, every one refused for the same capacity. SuperPipeline's release takes no
 * hint (no "not before", no reason) and its claim cannot exclude a card, so the Hub is where the wait
 * lives. It cannot skip one card in a claim, so it holds this station's checkpoint claims while the
 * released card's backoff runs: SuperBench capacity is the bench host's (disk, quota, slots), so the
 * next card on the same host would be refused for the same reason. Ordinary claims are never held.
 *
 * - **Growing and bounded.** The n-th consecutive capacity release of a card holds the station for
 *   `base * 2^(n-1)`, at most `max`.
 * - **A cap.** The `cap`-th consecutive capacity refusal of the same card is no longer released: the run
 *   is failed, naming capacity, so the board's own retry policy and circuit breaker decide and a person
 *   sees it. The count then starts again.
 * - **Reset.** Anything else that ends the card's attempt (a pass, another failure) forgets the card.
 *
 * Process memory only: a Hub restart forgets the counts, so a card can take up to `cap` more releases.
 */
export const CAPACITY_BACKOFF_BASE_MS = 60_000;
export const CAPACITY_BACKOFF_MAX_MS = 15 * 60_000;
export const CAPACITY_RELEASE_CAP = 6;
/** What recover returns while the station waits, so the claim cycle names it. */
export const CAPACITY_HOLD_REASON = "Checkpoint claims wait after a SuperBench capacity refusal";

export interface CapacityBackoff {
  /** True when this refusal of the card reaches the cap and must fail instead of releasing. */
  capped(card: string): boolean;
  /** The card's attempt ended on a capacity refusal; `failed` when the cap turned it into a failure. */
  refused(card: string, failed: boolean): void;
  /** The card's attempt ended any other way. */
  clear(card: string): void;
  /** When the station's checkpoint claims may resume, or undefined when they need not wait. */
  heldUntil(): number | undefined;
}

export function createCapacityBackoff(opts: { now?: () => number; baseMs?: number; maxMs?: number; cap?: number } = {}): CapacityBackoff {
  const now = opts.now ?? Date.now;
  const base = opts.baseMs ?? CAPACITY_BACKOFF_BASE_MS;
  const max = opts.maxMs ?? CAPACITY_BACKOFF_MAX_MS;
  const cap = opts.cap ?? CAPACITY_RELEASE_CAP;
  const counts = new Map<string, number>();
  let until = 0;
  return {
    capped: (card) => (counts.get(card) ?? 0) + 1 >= cap,
    refused(card, failed) {
      const n = (counts.get(card) ?? 0) + 1;
      until = Math.max(until, now() + Math.min(base * 2 ** Math.min(n - 1, 30), max));
      if (failed) counts.delete(card); else counts.set(card, n);
      // Bounded: a station sees few cards at once, but never let the map grow without limit.
      if (counts.size > 1024) counts.delete(counts.keys().next().value ?? card);
    },
    clear(card) { counts.delete(card); },
    heldUntil: () => (now() < until ? until : undefined),
  };
}

/**
 * What the station's recover answers when it has no unresolved attempt: undefined (claim as usual), or,
 * while a capacity backoff runs, an unresolved result that holds this station's checkpoint claims and
 * names why. Ordinary claims are unaffected (dispatch-run.ts).
 */
export function capacityHold(capacity: CapacityBackoff): { status: "unreported"; reason: string } | undefined {
  return capacity.heldUntil() === undefined ? undefined : { status: "unreported", reason: CAPACITY_HOLD_REASON };
}

/** The card a claim names, as the backoff keys it. */
export function capacityCard(claim: { tenantId: string; boardId: string; cardId: string }): string {
  return [claim.tenantId, claim.boardId, claim.cardId].join("\0");
}
