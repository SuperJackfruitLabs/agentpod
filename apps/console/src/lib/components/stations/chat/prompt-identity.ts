/** Retain the UUID until the daemon acknowledges it; a lost socket is not a new instruction. */
export class PendingPromptConflict extends Error {}
const key = (session: string) => "agentpod.salaam.pending:" + session;
export function rememberPrompt(
  storage: Storage,
  session: string,
  text: string,
): string {
  const raw = storage.getItem(key(session));
  if (raw) {
    const old = JSON.parse(raw) as { requestId: string; text: string };
    if (old.text !== text) throw new PendingPromptConflict("Wait for the previous message acknowledgment, or retry that message first.");
    if (old.text === text && /^[a-f0-9-]{36}$/.test(old.requestId))
      return old.requestId;
  }
  const requestId = crypto.randomUUID();
  storage.setItem(key(session), JSON.stringify({ requestId, text }));
  return requestId;
}
export function acknowledgePrompt(
  storage: Storage,
  session: string,
  requestId: string,
): void {
  const raw = storage.getItem(key(session));
  if (raw && JSON.parse(raw).requestId === requestId)
    storage.removeItem(key(session));
}
