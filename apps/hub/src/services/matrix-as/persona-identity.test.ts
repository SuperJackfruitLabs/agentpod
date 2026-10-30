import { describe, expect, test } from "bun:test";
import { personaIdentity, PERSONA_MAX_BYTES } from "./persona-identity";

describe("a Salaam persona's Matrix name and face", () => {
  test("a declared name line wins over the first heading", () => {
    expect(personaIdentity("# Research assistant\nname: Ada\n\nYou help.").name).toBe("Ada");
  });

  test("the first top-level heading names it when nothing is declared", () => {
    expect(personaIdentity("Intro line\n# Ada Lovelace\n## Style").name).toBe("Ada Lovelace");
  });

  test("a persona with neither names nothing, so the station's own name stays", () => {
    expect(personaIdentity("Be concise.").name).toBeNull();
  });

  test("a name is plain, single-line and bounded", () => {
    const id = personaIdentity("name: Ada\u0007‮ Lovelace " + "x".repeat(200));
    expect(id.name).not.toMatch(/[\u0000-\u001f\u007f‪-‮]/);
    expect(id.name!.length).toBeLessThanOrEqual(64);
    expect(id.name!.startsWith("Ada Lovelace")).toBe(true);
  });

  test("an avatar is a workspace-relative path, never a URL or a path out of the workspace", () => {
    expect(personaIdentity("avatar: brand/ada.png").avatarPath).toBe("brand/ada.png");
    for (const bad of [
      "avatar: https://example.com/ada.png",
      "avatar: mxc://id.agentpod.dev/abc",
      "avatar: ../secrets/key.png",
      "avatar: brand/../../etc/x.png",
      "avatar: /etc/ada.png",
      "avatar: ada.txt",
      "avatar: a b.png",
    ])
      expect(personaIdentity(bad).avatarPath, bad).toBeNull();
  });

  test("an oversized persona is not read at all", () => {
    const id = personaIdentity("name: Ada\n" + "x".repeat(PERSONA_MAX_BYTES));
    expect(id).toEqual({ name: null, avatarPath: null });
  });
});
