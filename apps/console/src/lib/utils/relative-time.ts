/**
 * relative-time.ts
 *
 * Human-readable relative time: "just now", "5m ago", "2h ago", "3d ago".
 * Shared by RecentActivity (fleet overview) and the activity page — both
 * previously carried identical copies of this helper.
 */

export function relativeTime(dateStr: string): string {
  try {
    const diff = Date.now() - new Date(dateStr).getTime();
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
