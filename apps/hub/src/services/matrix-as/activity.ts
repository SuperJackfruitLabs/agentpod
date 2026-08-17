/**
 * What the Matrix path does with the parts of an ACP turn it does not forward.
 *
 * `outbound.ts` answered exactly one question — "is this an
 * `agent_message_chunk`?" — and returned `undefined` for everything else. No
 * default case, no logging, no record. That is how `tool_call`,
 * `agent_thought_chunk`, `plan` and `usage_update` came to be discarded for the
 * whole life of the bridge with nothing anywhere saying so, while the console
 * rendered all of them.
 *
 * The kaambaan coalescer already keeps `unmapped()`/`losses()` and lists its
 * dropped kinds explicitly "so a NEW kind shows up in `unmapped()` instead of
 * joining this set by accident" (`bridge/coalesce.ts:53-62`). This is that
 * discipline, on the path that lacked it — and it ships before anything else in
 * this feature, because it is what makes the rest observable.
 */

/**
 * Kinds seen and not handled, for the life of the process.
 *
 * Module-level rather than per-attachment: the question is "does this fleet's
 * harness emit something we ignore", which is not a property of any one room.
 * A `Set` is also what makes the log once-per-kind rather than once-per-event —
 * a single turn emits hundreds of the same update, and a line per event would
 * bury the signal this exists to raise.
 */
const unmapped = new Set<string>();

/**
 * Records `kind` as unhandled. Returns whether it was **new**, so the caller
 * logs only the first time — a kind that arrives four hundred times says so
 * once.
 *
 * Guards the type rather than trusting it: `payload.sessionUpdate` comes off a
 * `z.unknown()` payload (`packages/contract`'s `AcpEvent`), so nothing upstream
 * promises it is a string or present at all. A non-string is not recorded,
 * because "we dropped something called 42" would be worse than silence.
 */
export function noteUnmappedKind(kind: string): boolean {
  if (typeof kind !== "string" || kind === "") return false;
  if (unmapped.has(kind)) return false;
  unmapped.add(kind);
  return true;
}

/** Every unhandled kind seen so far, sorted so two runs of a fleet read the same. */
export function unmappedKinds(): string[] {
  return [...unmapped].sort();
}

/**
 * Test seam. The set deliberately outlives any one attachment, so a test that
 * wants to observe it from empty has to say so.
 */
export function _resetUnmappedForTest(): void {
  unmapped.clear();
}
