/** Superlibrary's origin, which is also its audience. Unset: every Superlibrary feature is off. */
export function superlibraryConfig(): { url: string; audience: string } | null {
  const url = (process.env.SUPERLIBRARY_URL ?? "").trim().replace(/\/+$/, "");
  return url === "" ? null : { url, audience: url };
}
