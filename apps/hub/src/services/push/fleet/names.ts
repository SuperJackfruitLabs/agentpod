/**
 * The agent's name as the fleet card shows it.
 *
 * A Guild station's display name is its Hermes profile, `writer-quill`;
 * supermessage shows that agent as "Writer Quill" everywhere else (its core's
 * `display_name::humanise`). A slug — lower-case words joined by `-` or `_`,
 * nothing a person would type — is read the same way here. Anything else is
 * a name somebody chose and is left exactly as written.
 */
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export function cardName(displayName: string, mxid: string): string {
  const chosen = displayName.trim();
  if (chosen && !SLUG.test(chosen)) return chosen;
  const raw = chosen || localpart(mxid);
  if (!SLUG.test(raw)) return raw;
  return raw
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** `@agent_lyra:hs` → `lyra`: a name of last resort. */
function localpart(mxid: string): string {
  const local = mxid.replace(/^@/, "").split(":")[0] ?? mxid;
  return local.replace(/^agent_/, "") || mxid;
}
