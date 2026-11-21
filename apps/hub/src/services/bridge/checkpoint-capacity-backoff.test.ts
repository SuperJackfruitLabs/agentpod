import { expect, test } from "bun:test";
import { capacityCard, capacityHold, createCapacityBackoff, CAPACITY_BACKOFF_BASE_MS, CAPACITY_BACKOFF_MAX_MS, CAPACITY_HOLD_REASON,
  CAPACITY_RELEASE_CAP } from "./checkpoint-capacity-backoff";

const card = capacityCard({ tenantId: "tnt", boardId: "brd", cardId: "card_a" });
const other = capacityCard({ tenantId: "tnt", boardId: "brd", cardId: "card_b" });

// Seen on staging: a capacity release was claimed again at once, and one card reached 24 attempts in minutes.
test("each capacity release of a card holds the station longer, up to a ceiling", () => {
  let now = 0;
  const b = createCapacityBackoff({ now: () => now });
  expect(b.heldUntil()).toBeUndefined();
  const waits: number[] = [];
  for (let i = 0; i < 8; i++) {
    b.refused(card, false);
    const until = b.heldUntil();
    if (until === undefined) throw new Error("not held");
    waits.push(until - now);
    now = until; // the hold ran out; the card is claimed and refused again
    expect(b.heldUntil()).toBeUndefined();
  }
  expect(waits.slice(0, 5)).toEqual([1, 2, 4, 8, 15].map((m) => Math.min(m * CAPACITY_BACKOFF_BASE_MS, CAPACITY_BACKOFF_MAX_MS)));
  expect(Math.max(...waits)).toBe(CAPACITY_BACKOFF_MAX_MS);
});

test("the cap-th consecutive capacity refusal of a card is capped, and the count then starts again", () => {
  const b = createCapacityBackoff({ now: () => 0 });
  for (let i = 1; i < CAPACITY_RELEASE_CAP; i++) {
    expect(b.capped(card)).toBe(false);
    b.refused(card, false);
  }
  expect(b.capped(card)).toBe(true);
  expect(b.capped(other)).toBe(false);
  b.refused(card, true);
  expect(b.capped(card)).toBe(false);
});

test("any other outcome forgets the card", () => {
  const b = createCapacityBackoff({ now: () => 0 });
  for (let i = 1; i < CAPACITY_RELEASE_CAP; i++) b.refused(card, false);
  b.clear(card);
  expect(b.capped(card)).toBe(false);
});

test("while the backoff runs, recover holds the station's checkpoint claims and names why", () => {
  let now = 0;
  const b = createCapacityBackoff({ now: () => now });
  expect(capacityHold(b)).toBeUndefined();
  b.refused(card, false);
  expect(capacityHold(b)).toEqual({ status: "unreported", reason: CAPACITY_HOLD_REASON });
  now = CAPACITY_BACKOFF_BASE_MS;
  expect(capacityHold(b)).toBeUndefined();
});
