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
  test("the default is still the mode that needs nobody", () => {
    // Deliberately NOT changed when `ask` became answerable. A default is what
    // an unattended board gets, and `ask` asks about every tool call: a hub
    // upgraded into it would start parking cards on questions at 3am and
    // failing them when the wait ran out.
    enabled();
    expect(loadBridgeConfig()!.agents[0]!.mode).toBe("full-auto");
  });

  test("accept-edits is allowed", () => {
    enabled({ mode: "accept-edits" });
    expect(loadBridgeConfig()!.agents[0]!.mode).toBe("accept-edits");
  });

  test("ask is allowed — kaambaan can answer a question now", () => {
    // The refusal this replaces was correct when it was written: the
    // `input-required → working` transition existed and nothing invoked it.
    // kaambaan PR #36 built the return path, so the reason is gone.
    enabled({ mode: "ask" });
    expect(loadBridgeConfig()!.agents[0]!.mode).toBe("ask");
  });
});

describe("how long a human has to answer", () => {
  test("unset means the built-in wait, not an unbounded one", () => {
    enabled();
    expect(loadBridgeConfig()!.agents[0]!.permissionWaitMs).toBeUndefined();
  });

  test("a board with someone watching it can be given a different wait", () => {
    enabled({ permissionWaitMs: 5 * 60_000 });
    expect(loadBridgeConfig()!.agents[0]!.permissionWaitMs).toBe(300_000);
  });

  test("a wait of zero or less is refused — it is not a policy, it is a bug", () => {
    enabled({ permissionWaitMs: 0 });
    expect(() => loadBridgeConfig()).toThrow();
    enabled({ permissionWaitMs: -1 });
    expect(() => loadBridgeConfig()).toThrow();
  });
});
