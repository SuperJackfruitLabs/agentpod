/**
 * The gate, and the two environment facts that survived.
 *
 * A hub that has not opted in must behave exactly as it does today — same as the provisioner
 * drivers, which are registered only when their `ENABLE_*` flag is literally "true" and are
 * otherwise invisible.
 *
 * The roster is no longer among the things checked here: it moved to `bridge_agents`, and the
 * tests for it are `tests/integration/bridge-roster.test.ts`. What is left is the deployment
 * configuration proper — whether to run, which superpipeline, and the key without which no
 * rostered credential can be read.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { isBridgeEnabled, loadBridgeConfig, BRIDGE_ENV_FLAG } from "./config";

const KEYS = [BRIDGE_ENV_FLAG, "SUPERPIPELINE_BASE_URL", "ENCRYPTION_KEY"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function env(over: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(over)) if (v !== undefined) process.env[k] = v;
}

const enabled = () =>
  env({
    [BRIDGE_ENV_FLAG]: "true",
    SUPERPIPELINE_BASE_URL: "https://superpipeline.example",
    ENCRYPTION_KEY: "a-test-encryption-key-0123456789",
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
      env({ [BRIDGE_ENV_FLAG]: v, SUPERPIPELINE_BASE_URL: "https://k", ENCRYPTION_KEY: "k".repeat(32) });
      expect(isBridgeEnabled()).toBe(false);
      expect(loadBridgeConfig()).toBeNull();
    }
  });

  test("off means nothing else is even read — a half-configured hub still boots", () => {
    env({ [BRIDGE_ENV_FLAG]: "false" });
    expect(() => loadBridgeConfig()).not.toThrow();
  });
});

describe("what an enabled bridge still needs from the environment", () => {
  test("the base url, without which there is no superpipeline to claim from", () => {
    env({ [BRIDGE_ENV_FLAG]: "true", ENCRYPTION_KEY: "k".repeat(32) });
    expect(() => loadBridgeConfig()).toThrow(/SUPERPIPELINE_BASE_URL/);
  });

  test("the encryption key, without which every rostered credential is unreadable", () => {
    // The roster would load as a list of agents, none of which could claim: an outage whose cause
    // is three layers from its symptom. This is an environment fact, so it is still catchable at
    // boot even though the roster itself is not.
    env({ [BRIDGE_ENV_FLAG]: "true", SUPERPIPELINE_BASE_URL: "https://superpipeline.example" });
    expect(() => loadBridgeConfig()).toThrow(/ENCRYPTION_KEY/);
  });

  test("a trailing slash on the base url is stripped, so paths join predictably", () => {
    env({
      [BRIDGE_ENV_FLAG]: "true",
      SUPERPIPELINE_BASE_URL: "https://superpipeline.example///",
      ENCRYPTION_KEY: "k".repeat(32),
    });
    expect(loadBridgeConfig()!.baseUrl).toBe("https://superpipeline.example");
  });

  test("configured, it reports the source every ledger row is written under", () => {
    enabled();
    expect(loadBridgeConfig()).toEqual({ baseUrl: "https://superpipeline.example", source: "superpipeline" });
  });

  test("it no longer carries a roster — that is the table's job now", () => {
    enabled();
    expect(loadBridgeConfig()).not.toHaveProperty("agents");
  });
});
