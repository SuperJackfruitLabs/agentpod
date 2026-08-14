/**
 * The gate. A hub that has not opted in must behave exactly as it does today —
 * same as the provisioner drivers, which are registered only when their
 * `ENABLE_*` flag is literally "true" and are otherwise invisible.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { isBridgeEnabled, loadBridgeConfig, BRIDGE_ENV_FLAG } from "./config";

const KEYS = [BRIDGE_ENV_FLAG, "KAAMBAAN_BASE_URL", "KAAMBAAN_BRIDGE_AGENTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

const AGENT = {
  key: "codex-mac",
  boardId: "brd_9c1d4e5f6a7b8c9d",
  token: `kbn_${"a1b2c3d4".repeat(6)}`,
  stationId: "station_4a1482de-9c3f-4b17-8a55-0d6e2f7c1b90",
  hubUserId: "usr-local-1",
};

function env(over: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(over)) if (v !== undefined) process.env[k] = v;
}

const enabled = (over: Record<string, unknown> = {}) =>
  env({
    [BRIDGE_ENV_FLAG]: "true",
    KAAMBAAN_BASE_URL: "https://kaambaan.example",
    KAAMBAAN_BRIDGE_AGENTS: JSON.stringify([{ ...AGENT, ...over }]),
  });

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe("the bridge is off unless it is switched on", () => {
  test("unset is off", () => {
    env({});
    expect(isBridgeEnabled()).toBe(false);
    expect(loadBridgeConfig()).toBeNull();
  });

  test("only the literal string 'true' enables it", () => {
    for (const v of ["false", "1", "yes", "TRUE", ""]) {
      env({ [BRIDGE_ENV_FLAG]: v, KAAMBAAN_BASE_URL: "https://k", KAAMBAAN_BRIDGE_AGENTS: "[]" });
      expect(isBridgeEnabled()).toBe(false);
    }
  });

  test("credentials alone never enable it", () => {
    // The provisioner rule: nothing is inferred from credentials being present.
    // A token left in an env file is not a decision to start claiming work.
    env({ KAAMBAAN_BASE_URL: "https://k", KAAMBAAN_BRIDGE_AGENTS: JSON.stringify([AGENT]) });
    expect(isBridgeEnabled()).toBe(false);
    expect(loadBridgeConfig()).toBeNull();
  });

  test("switched on with a valid agent, it loads", () => {
    enabled();
    const cfg = loadBridgeConfig()!;
    expect(cfg.baseUrl).toBe("https://kaambaan.example");
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0]!.key).toBe("codex-mac");
    expect(cfg.source).toBe("kaambaan");
  });
});

describe("an enabled bridge refuses to start half-configured", () => {
  test("no base URL", () => {
    env({ [BRIDGE_ENV_FLAG]: "true", KAAMBAAN_BRIDGE_AGENTS: JSON.stringify([AGENT]) });
    expect(() => loadBridgeConfig()).toThrow(/KAAMBAAN_BASE_URL/);
  });

  test("no agents", () => {
    env({ [BRIDGE_ENV_FLAG]: "true", KAAMBAAN_BASE_URL: "https://k", KAAMBAAN_BRIDGE_AGENTS: "[]" });
    expect(() => loadBridgeConfig()).toThrow(/KAAMBAAN_BRIDGE_AGENTS/);
  });

  test("unparseable agents", () => {
    env({ [BRIDGE_ENV_FLAG]: "true", KAAMBAAN_BASE_URL: "https://k", KAAMBAAN_BRIDGE_AGENTS: "{not json" });
    expect(() => loadBridgeConfig()).toThrow(/KAAMBAAN_BRIDGE_AGENTS/);
  });

  test("a token that is not a kaambaan agent token", () => {
    enabled({ token: "hunter2" });
    expect(() => loadBridgeConfig()).toThrow(/kbn_/);
  });

  test("two agents sharing a key", () => {
    // `key` lands in bridge_dispatches.agent_key and in every log line. Two
    // identities under one name make an attribution question unanswerable.
    env({
      [BRIDGE_ENV_FLAG]: "true",
      KAAMBAAN_BASE_URL: "https://k",
      KAAMBAAN_BRIDGE_AGENTS: JSON.stringify([AGENT, { ...AGENT, boardId: "brd_other" }]),
    });
    expect(() => loadBridgeConfig()).toThrow(/codex-mac/);
  });
});

describe("permission mode", () => {
  test("defaults to a mode that does not block", () => {
    // Spike RQ2: an elicitation is a dead end. kaambaan defines the
    // `input-required → working` transition and NOTHING invokes it, no gate is
    // created, and no code anywhere constructs a `prompt` activity. A blocking
    // mode would park every permission request until the 15-minute reclaim.
    enabled();
    expect(loadBridgeConfig()!.agents[0]!.mode).toBe("full-auto");
  });

  test("accept-edits is allowed", () => {
    enabled({ mode: "accept-edits" });
    expect(loadBridgeConfig()!.agents[0]!.mode).toBe("accept-edits");
  });

  test("ask is refused, and the refusal says why", () => {
    enabled({ mode: "ask" });
    expect(() => loadBridgeConfig()).toThrow(/no return path/i);
  });
});
