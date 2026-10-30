/**
 * What a Salaam persona says about the agent's Matrix name and face (item 9, steps 2-3).
 *
 * The persona is the operator's own text, pinned by digest in the host manifest and reported by
 * the node read-only (`salaam.persona`, agentpod #809). This reads two optional lines from it and
 * nothing else:
 *
 *   name: Ada          the display name; otherwise the first top-level `# heading`
 *   avatar: brand/a.png  a workspace-relative image, tried before the usual avatar candidates
 *
 * Deliberately narrow: plain text only, bounded, and an avatar is a path inside the workspace —
 * never a URL, so the hub never fetches anything a persona names.
 */

/** Salaam caps a persona at 16 KiB; anything larger is not a persona this reads. */
export const PERSONA_MAX_BYTES = 16 * 1024;
const NAME_MAX = 64;

export interface PersonaIdentity {
  name: string | null;
  avatarPath: string | null;
}

function plain(value: string): string | null {
  // Control and bidirectional-override characters out, whitespace collapsed, bounded.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return cleaned || null;
}

const IMAGE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]+\.(?:png|jpe?g|gif|webp)$/i;

export function personaIdentity(text: string): PersonaIdentity {
  if (new TextEncoder().encode(text).length > PERSONA_MAX_BYTES) return { name: null, avatarPath: null };
  const lines = text.split(/\r?\n/);
  const declared = lines.find((l) => /^name:\s*\S/i.test(l));
  const heading = lines.find((l) => /^#\s+\S/.test(l));
  const name = declared
    ? plain(declared.replace(/^name:\s*/i, ""))
    : heading
      ? plain(heading.replace(/^#\s+/, ""))
      : null;
  const avatar = lines.find((l) => /^avatar:\s*\S/i.test(l))?.replace(/^avatar:\s*/i, "").trim();
  return { name, avatarPath: avatar && !avatar.includes("://") && IMAGE_PATH.test(avatar) ? avatar : null };
}
