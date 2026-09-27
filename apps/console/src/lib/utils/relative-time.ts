/**
 * relative-time.ts
 *
 * Human-readable relative time: "just now", "5m ago", "2h ago", "3d ago".
 * Shared by ActivityFeed (the muster and the activity page), the nodes
 * table's "last seen", and file-preview's "modified" timestamp — all
 * previously carried identical (or near-identical) copies of this helper.
 *
 * `null` (file-preview's "no timestamp available" case) → "unknown".
 * Unparseable date strings → "?" (also covers `new Date()` throwing, which
 * doesn't happen for string input in practice, but is guarded regardless).
 */

export function relativeTime(dateStr: string | null): string {
  if (dateStr === null) return "—";
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (Number.isNaN(diff)) return "?";
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return "?";
  }
}
