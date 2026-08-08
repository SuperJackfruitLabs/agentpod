/**
 * Visibility-aware polling.
 *
 * Runs `fn` every `intervalMs` while the document is visible, skips ticks in
 * hidden tabs (no wasted requests, no battery drain), and fires immediately
 * when the tab becomes visible again so the user never looks at data older
 * than one interval. Returns a stop function for onMount cleanup.
 */
export function startPolling(fn: () => void, intervalMs: number): () => void {
  const tick = () => {
    if (!document.hidden) fn();
  };
  const id = setInterval(tick, intervalMs);
  const onVisible = () => {
    if (!document.hidden) fn();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
