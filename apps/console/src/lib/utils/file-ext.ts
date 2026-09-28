/**
 * Shared file-extension helpers used by both FileBrowser (tree/tabs) and
 * FilePreview (content rendering) to decide whether a path is binary.
 * Kept as the single source of truth so the two views can't drift apart on
 * what counts as "binary".
 */

/** Extensions the station API can't return usable text content for. */
export const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico",
  "woff", "woff2", "ttf", "zip", "gz", "tar", "bin", "exe", "pdf",
]);

/** Lower-cased extension of a path/name, or "" when there isn't one. */
export function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 || idx === path.length - 1 ? "" : path.slice(idx + 1).toLowerCase();
}

/**
 * Image types the browser can show from a Blob and a homeserver takes as an
 * avatar. SVG is left out: no Matrix client renders one as a face.
 */
export const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
