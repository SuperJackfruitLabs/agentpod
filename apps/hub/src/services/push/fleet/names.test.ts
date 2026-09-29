import { describe, expect, test } from "bun:test";

import { cardName } from "./names";

describe("the name on the card", () => {
  test("a profile slug reads as the agent's name, as supermessage shows it", () => {
    expect(cardName("writer-quill", "@agent_writer-quill:hs")).toBe("Writer Quill");
    expect(cardName("super_chotu", "@agent_super_chotu:hs")).toBe("Super Chotu");
    expect(cardName("coder-kai", "@agent_coder-kai:hs")).toBe("Coder Kai");
  });

  test("a name a person wrote is left exactly as written", () => {
    expect(cardName("Research Ray", "@agent_research-ray:hs")).toBe("Research Ray");
    expect(cardName("iOS helper", "@agent_ios:hs")).toBe("iOS helper");
    expect(cardName("Hermes", "@agent_hermes:hs")).toBe("Hermes");
  });

  test("with no display name, the Matrix localpart, read the same way", () => {
    expect(cardName("", "@agent_artistic-lyra:id.agentpod.dev")).toBe("Artistic Lyra");
    expect(cardName("  ", "@lyra:hs")).toBe("Lyra");
  });
});
