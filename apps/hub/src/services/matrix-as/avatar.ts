/**
 * An agent's face, if it has one.
 *
 * hermes profiles carry a `pfp.png` and hermes's own tooling uploaded it, which
 * is why those 14 agents had faces and every other station had a letter. None of
 * that is hermes-specific: the bridge looks in the same places for every
 * harness, and an agent with no image is not a broken agent.
 *
 * Read through the node, because the image lives in the station's workspace on
 * whichever machine that is — and read once, at provisioning, because an avatar
 * is not worth a round trip per message.
 */

/**
 * Where an agent's picture might be, in order of preference.
 *
 * Deliberately not keyed by harness. A convention that only worked for the one
 * harness that already had faces would bake in the accident this bridge exists
 * to remove.
 */
export const AVATAR_CANDIDATES = ["avatar.png", "pfp.png", ".agentpod/avatar.png"] as const;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface AvatarDeps {
  /** Read a workspace-relative path, or null when it is not there. */
  read(path: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}

export interface FoundAvatar {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export async function pickAvatar(deps: AvatarDeps): Promise<FoundAvatar | null> {
  for (const path of AVATAR_CANDIDATES) {
    let found: { bytes: Uint8Array; contentType: string } | null = null;
    try {
      found = await deps.read(path);
    } catch {
      // The workspace is on another machine, which may be offline or busy. An
      // avatar is never worth failing provisioning over.
      return null;
    }
    if (!found) continue;

    // The path is a convention, not a promise. Uploading a text file as an
    // avatar fails later and more confusingly than declining it here.
    if (!IMAGE_TYPES.includes(found.contentType)) continue;

    return { path, ...found };
  }
  return null;
}
