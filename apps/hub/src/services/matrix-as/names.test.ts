import { describe, expect, test } from "bun:test";
import { bridgeUserId, bridgeAlias, bridgeLocalpart, localpartFor, isBridgeUser } from "./names";

/**
 * An agent's Matrix name, and a room's.
 *
 * `bridgeUserId`/`bridgeLocalpart` are derived from a principal's `handle` —
 * immutable, and the same wherever the agent runs
 * (`charter` → decisions/2026-08-30-an-agent-is-a-principal.md). `bridgeAlias`
 * still derives from the `(node, stationKey)` pair that names a *station*: a
 * room is a place, not the identity that occupies it, and station keys repeat
 * across the fleet — `opencode:c52ddf65` exists on two nodes today.
 */

const D = "id.agentpod.dev";

describe("bridge names", () => {
  test("an agent's address survives moving between nodes", () => {
    // The principle the strategy states twice: an agent is an identity, a
    // station is a location. Derived from node+station, moving an agent made
    // it a different person in chat.
    expect(bridgeUserId("writer-quill", "id.agentpod.dev")).toBe(
      "@agent_writer-quill:id.agentpod.dev"
    );
  });

  test("still lands inside the exclusive @agent_.* namespace", () => {
    // Outside it the appservice may not act — a 403 that arrives later and
    // elsewhere.
    expect(bridgeLocalpart("Writer Quill")).toMatch(/^agent_[a-z0-9._=/-]+$/);
  });

  test("lowercase, because Matrix localparts are", () => {
    expect(bridgeUserId("BOX", D)).toBe("@agent_box:id.agentpod.dev");
  });

  test("replaces characters an mxid localpart may not contain", () => {
    // `:` is the mxid separator, and a handle picked before this rule existed
    // could still contain one.
    expect(bridgeUserId("box:pi", D)).toBe("@agent_box-pi:id.agentpod.dev");
  });

  test("the registered username is exactly the user id's localpart", () => {
    // Registering the bare handle creates a user OUTSIDE the exclusive
    // namespace, where the appservice may not act — and the failure surfaces
    // later and elsewhere, as a 403 at send time.
    const userId = bridgeUserId("molt-bot", D);
    expect(userId).toBe(`@${bridgeLocalpart("molt-bot")}:${D}`);
    expect(bridgeLocalpart("molt-bot").startsWith("agent_")).toBe(true);
  });

  test("are stable — the same handle always gets the same name", () => {
    // A name that drifted would strand rooms behind identities nobody answers
    // for.
    expect(bridgeUserId("molt-bot", D)).toBe(bridgeUserId("molt-bot", D));
  });
});

describe("room names, still keyed to a station", () => {
  test("name a node as well as a station", () => {
    // `opencode:c52ddf65` exists on two nodes in production right now. A name
    // that omitted the node would merge two different agents' rooms on two
    // different machines — the collision this suite has already undone once,
    // for grants. A room's address is not an agent's, so it stays derived from
    // where the station runs.
    const a = bridgeAlias("cloudchamber", "opencode:c52ddf65", D);
    const b = bridgeAlias("9247e5a88cfa", "opencode:c52ddf65", D);
    expect(a).not.toBe(b);
  });

  test("land inside the namespace the homeserver reserved", () => {
    // agents.yaml claims `#agentpod_.*` exclusive. A name outside it cannot be
    // acted as, and the failure arrives late — a 403 from the homeserver at
    // send time, long after provisioning "worked".
    expect(bridgeAlias("molt-bot", "hermes:analyst-echo", D)).toBe(
      "#agentpod_molt-bot_hermes-analyst-echo:id.agentpod.dev"
    );
  });

  test("replace characters a room alias's localpart may not contain", () => {
    // `:` is the mxid separator, and a station key is full of them.
    expect(bridgeAlias("box", "claude-code:48c62ea7", D)).toBe(
      "#agentpod_box_claude-code-48c62ea7:id.agentpod.dev"
    );
  });

  test("keep the node and the station distinguishable", () => {
    // A separator that could also appear inside either half would make
    // `a_b`/`c` and `a`/`b_c` the same name. They must not collide.
    expect(localpartFor("a_b", "c")).not.toBe(localpartFor("a", "b_c"));
  });

  test("never emit the separator from a name's own characters", () => {
    // This is what makes one underscore enough. Two illegal characters in a row
    // used to produce `__` inside a half, which is how the doubled separator
    // was safe in practice and not in principle.
    expect(localpartFor("a::b", "c")).not.toContain("__");
    expect(localpartFor("a_b", "c").split("_")).toHaveLength(2);
  });

  test("are stable — the same station always gets the same name", () => {
    expect(bridgeAlias("molt-bot", "hermes:coder-kai", D)).toBe(
      bridgeAlias("molt-bot", "hermes:coder-kai", D)
    );
  });
});

describe("isBridgeUser", () => {
  test("recognises our own users, which is how the echo loop is cut", () => {
    // An Application Service receives what its own users send. Answering those
    // is an infinite loop that fills a database overnight, so this predicate
    // runs before anything else looks at an event.
    expect(isBridgeUser("@agent_box_pi-59099bf1:id.agentpod.dev", D)).toBe(true);
  });

  test("recognises the appservice's own bot", () => {
    expect(isBridgeUser("@ai-bridge:id.agentpod.dev", D)).toBe(true);
  });

  test("does not claim humans", () => {
    expect(isBridgeUser("@rakesh:id.agentpod.dev", D)).toBe(false);
  });

  test("does not claim a lookalike from another server", () => {
    // Federation is off today and may not always be. A name that merely looks
    // like ours, on someone else's homeserver, is not ours.
    expect(isBridgeUser("@agent_x:example.org", D)).toBe(false);
    expect(isBridgeUser("@ai-bridge:example.org", D)).toBe(false);
  });

  test("does not claim a user whose name merely starts like the domain", () => {
    // `:id.agentpod.dev.evil.example` ends with neither our domain nor a
    // boundary — a suffix check without the colon would have accepted it.
    expect(isBridgeUser("@agent_x:id.agentpod.dev.evil.example", D)).toBe(false);
  });

  test("survives junk without throwing, because it runs on untrusted input", () => {
    expect(isBridgeUser("", D)).toBe(false);
    expect(isBridgeUser("not-an-mxid", D)).toBe(false);
  });
});
