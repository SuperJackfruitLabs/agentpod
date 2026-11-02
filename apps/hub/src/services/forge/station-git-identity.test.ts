import { describe, expect, test } from "bun:test";

import { commitAuthorFor, readableName } from "./station-git-identity";

describe("readableName", () => {
  test("a handle-shaped name becomes words", () => {
    expect(readableName("fixture-agent")).toBe("Fixture Agent");
    expect(readableName("fixture_agent")).toBe("Fixture Agent");
    expect(readableName("fixture")).toBe("Fixture");
  });

  test("a display name that is a station key names the agent, not the harness", () => {
    // Agents adopted from a station have been given its key (`harness:name`) as their display name.
    expect(readableName("fixture-harness:fixture-agent")).toBe("Fixture Agent");
  });

  test("a name somebody already wrote for people is left as they wrote it", () => {
    expect(readableName("Fixture Agent")).toBe("Fixture Agent");
    expect(readableName("McFixture")).toBe("McFixture");
    expect(readableName("fixture the agent")).toBe("fixture the agent");
  });

  test("characters git would strip from an ident are removed, not passed through", () => {
    expect(readableName("Fixture <Agent>\n")).toBe("Fixture Agent");
  });
});

describe("commitAuthorFor", () => {
  const forgeUser = { id: 7, login: "fixture-agent", email: "fixture-agent@agents.example", full_name: "fixture-agent (agent)" };

  test("the agent's display name, in readable form, with the forge account's own email", () => {
    expect(commitAuthorFor({ displayName: "fixture-agent", forgeUser })).toEqual({
      name: "Fixture Agent",
      email: "fixture-agent@agents.example",
    });
  });

  test("no display name: the forge full name without its (agent) suffix", () => {
    expect(commitAuthorFor({ displayName: null, forgeUser })).toEqual({
      name: "Fixture Agent",
      email: "fixture-agent@agents.example",
    });
    expect(commitAuthorFor({ displayName: "  ", forgeUser: { ...forgeUser, full_name: "" } })!.name).toBe("Fixture Agent");
  });

  test("the email is forge's, never constructed here", () => {
    // A forge whose account carries a different address than the convention would produce: the
    // commit has to match the account, or forge cannot link it.
    const author = commitAuthorFor({ displayName: null, forgeUser: { ...forgeUser, email: "other@agents.example" } });
    expect(author!.email).toBe("other@agents.example");
  });

  test("no email from forge is no author — the host's would be a worse lie than none", () => {
    expect(commitAuthorFor({ displayName: "fixture-agent", forgeUser: { ...forgeUser, email: "" } })).toBeNull();
  });
});
