/**
 * Whether a question still goes out as TWO events.
 *
 * A permission request and a superpipeline gate now ride inside their prose
 * message (`dev.agentpod.permission`, `dev.superpipeline.gate` —
 * `packages/contract/src/matrix-events.ts`). The separate custom events
 * (`dev.agentpod.permission.v1`, `dev.superpipeline.gate.v1`) are still sent
 * beside them while this is on, because supermessage builds in the field read
 * only those.
 *
 * ON unless `AGENTPOD_LEGACY_PERMISSION_EVENTS` is `false` or `0`. Read per
 * call rather than at import, so turning it off is an env change and a restart
 * with nothing cached in between — and so a test can flip it.
 */
export function legacyRequestEvents(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.AGENTPOD_LEGACY_PERMISSION_EVENTS?.trim().toLowerCase();
  return !(value === "false" || value === "0");
}
