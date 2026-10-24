/**
 * The decision to offer now. A board holds one open question per run, and offering a second
 * cancels the first (run_e1505c872e9249f7), so strict decisions go out one at a time: the oldest,
 * by expiry and then request id, and the next only once it is answered or expired.
 */
export function nextSalaamDecision<T extends { request_id: string; expires_at: number }>(
  decisions: readonly T[],
): T | undefined {
  return [...decisions].sort(
    (a, b) => a.expires_at - b.expires_at || (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0),
  )[0];
}
