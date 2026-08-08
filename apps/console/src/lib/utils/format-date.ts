/**
 * format-date.ts
 *
 * Consolidates the two page-local `formatDate` helpers previously
 * duplicated between the admin users list page (short: "Jun 29, 2026") and
 * the admin user-detail page (long: full month name + day + year + time).
 * Both wrapped `toLocaleDateString(undefined, {...})` with a fixed option
 * set — this copies those exact configs behind a single `style` switch.
 */

export type FormatDateStyle = "short" | "long";

export function formatDate(iso: string, style: FormatDateStyle = "short"): string {
  const date = new Date(iso);

  if (style === "long") {
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
