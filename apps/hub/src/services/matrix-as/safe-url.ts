/**
 * The one test of a link this hub carries into a room: an absolute `https://` address with a host.
 * Pure. Moved out of `gate-wire.ts`, which re-exports it, so the wires `gate-wire.ts` imports can
 * use it too without importing it back.
 */

/** Is this an absolute `https://` address with a host? */
export function isHttpsUrl(v: string): boolean {
  if (!/^https:\/\/[^\s<>]+$/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}
