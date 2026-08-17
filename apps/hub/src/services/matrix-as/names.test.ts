import { describe, expect, test } from "bun:test";
import { bridgeUserId, bridgeAlias, bridgeLocalpart, localpartFor, isBridgeUser } from "./names";

/**
 * A Matrix name for a station.
 *
 * Derived, never stored: from the same `(node, stationKey)` pair that already
 * identifies a station in a grant
 * (`charter` → decisions/2026-08-15-a-grant-names-an-agent-per-plane.md). A
 * mapping table would be a second source of truth for a fact the fleet knows.
 */

const D = "id.agentpod.dev";

describe("bridge names", () => {
  test("name a node as well as a station", () => {
    // `opencode:c52ddf65` exists on two nodes in production right now. A name
    // that omitted the node would merge two different agents on two different
    // machines — the collision this suite has already undone once, for grants.
    const a = bridgeUserId("cloudchamber", "opencode:c52ddf65", D);
    const b = bridgeUserId("9247e5a88cfa", "opencode:c52ddf65", D);
    expect(a).not.toBe(b);
  });

  test("land inside the namespace the homeserver reserved", () => {
    // agents.yaml claims `@agent_.*` and `#agentpod_.*` exclusive. A name
    // outside them cannot be acted as, and the failure arrives late — a 403
    // from the homeserver at send time, long after provisioning "worked".
    // One `_`, and it is unambiguous because `_` cannot survive cleaning:
    // every underscore in a station key or node name becomes `-`.
    expect(bridgeUserId("molt-bot", "hermes:analyst-echo", D)).toBe(
      "@agent_molt-bot_hermes-analyst-echo:id.agentpod.dev"
    );
    expect(bridgeAlias("molt-bot", "hermes:analyst-echo", D)).toBe(
      "#agentpod_molt-bot_hermes-analyst-echo:id.agentpod.dev"
    );
  });

  test("replace characters an mxid localpart may not contain", () => {
    // `:` is the mxid separator, and a station key is full of them.
    expect(bridgeUserId("box", "claude-code:48c62ea7", D)).toBe(
      "@agent_box_claude-code-48c62ea7:id.agentpod.dev"
    );
  });

  test("lowercase, because Matrix localparts are", () => {
    expect(bridgeUserId("BOX", "Pi:59099BF1", D)).toBe("@agent_box_pi-59099bf1:id.agentpod.dev");
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

  test("the registered username is exactly the user id's localpart", () => {
    // Registering the bare name creates a user OUTSIDE the exclusive namespace,
    // where the appservice may not act — and the failure surfaces later and
    // elsewhere, as a 403 at send time.
    const userId = bridgeUserId("molt-bot", "hermes:coder-kai", D);
    expect(userId).toBe(`@${bridgeLocalpart("molt-bot", "hermes:coder-kai")}:${D}`);
    expect(bridgeLocalpart("molt-bot", "hermes:coder-kai").startsWith("agent_")).toBe(true);
  });

  test("are stable — the same station always gets the same name", () => {
    // Provisioning runs on every adoption and every boot. A name that drifted
    // would strand rooms behind identities nobody answers for.
    expect(bridgeUserId("molt-bot", "hermes:coder-kai", D)).toBe(
      bridgeUserId("molt-bot", "hermes:coder-kai", D)
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
