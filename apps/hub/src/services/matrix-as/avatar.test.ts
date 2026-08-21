import { describe, expect, test } from "bun:test";
import { AVATAR_CANDIDATES, pickAvatar } from "./avatar";

/**
 * An agent's face, if it has one.
 *
 * hermes profiles carry a `pfp.png`, and its own tooling uploaded it — which is
 * why those agents had faces and, after the bridge took over, letter avatars.
 * Nothing about that is hermes-specific: any harness that keeps an image beside
 * its agent should get the same treatment, and an agent with no image is not a
 * broken agent.
 */

describe("finding an agent's avatar", () => {
  test("looks in the same places for every harness", () => {
    // The candidate list is not keyed by harness. A convention that only worked
    // for the one harness that already had faces would bake in the accident
    // this bridge exists to remove.
    expect(AVATAR_CANDIDATES.length).toBeGreaterThan(0);
    expect(AVATAR_CANDIDATES.join(" ")).not.toMatch(/hermes|openclaw|codex/i);
  });

  test("takes the first candidate the station actually has", async () => {
    const found = await pickAvatar({
      read: async (path) =>
        path === AVATAR_CANDIDATES[1]
          ? { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" }
          : null,
    });

    expect(found).not.toBeNull();
    expect(found!.path).toBe(AVATAR_CANDIDATES[1]);
  });

  test("answers null when the agent has no image, which is not an error", async () => {
    // Optional means optional. A station without a picture must provision
    // exactly as far as one with it.
    expect(await pickAvatar({ read: async () => null })).toBeNull();
  });

  test("survives a node that will not answer", async () => {
    // The workspace is on another machine, which may be offline. An avatar is
    // never worth failing provisioning over.
    const found = await pickAvatar({
      read: async () => {
        throw new Error("node offline");
      },
    });
    expect(found).toBeNull();
  });

  test("refuses something that is not an image", async () => {
    // The path is a convention, not a promise. Uploading a text file as an
    // avatar would fail later and more confusingly.
    const found = await pickAvatar({
      read: async () => ({ bytes: new Uint8Array([1]), contentType: "text/plain" }),
    });
    expect(found).toBeNull();
  });

  test("falls back to the harness mark when the workspace has nothing", async () => {
    const found = await pickAvatar({
      read: async () => null,
      harness: "claude-code",
      stationKey: "claude-code:c2c9f8e2",
    });

    expect(found).not.toBeNull();
    expect(found!.contentType).toBe("image/png");
    // The path names where it came from, so the provisioning log distinguishes
    // "found the agent's own picture" from "drew one".
    expect(found!.path).toBe("harness:claude-code");
  });

  test("prefers the agent's own picture over its harness's logo", async () => {
    // A picture someone put in the workspace is a deliberate act. The mark is
    // what we draw for the agents nobody has bothered with.
    const own = new Uint8Array([1, 2, 3]);
    const found = await pickAvatar({
      read: async (path) =>
        path === AVATAR_CANDIDATES[0]
          ? { bytes: own, contentType: "image/png" }
          : null,
      harness: "claude-code",
      stationKey: "claude-code:c2c9f8e2",
    });

    expect(found!.path).toBe(AVATAR_CANDIDATES[0]);
    expect(found!.bytes).toEqual(own);
  });

  test("still answers null for a harness we have no mark for", async () => {
    // The fallback is an asset lookup, not a promise that every station gets a
    // face. A hermes agent without a `pfp.png` stays a letter.
    const found = await pickAvatar({
      read: async () => null,
      harness: "hermes",
      stationKey: "hermes:coder-kai",
    });
    expect(found).toBeNull();
  });

  test("falls back even when the node refused to answer", async () => {
    // An offline node is exactly when a station has no reachable picture — and
    // exactly when a drawn one is the only face available.
    const found = await pickAvatar({
      read: async () => {
        throw new Error("node offline");
      },
      harness: "opencode",
      stationKey: "opencode:18be38ff",
    });
    expect(found).not.toBeNull();
    expect(found!.path).toBe("harness:opencode");
  });
});
