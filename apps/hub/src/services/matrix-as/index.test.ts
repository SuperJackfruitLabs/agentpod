import { describe, expect, test } from "bun:test";
import { matrixBridgeConfig, matrixBridgeProblems, createMatrixBridge } from "./index";

/**
 * The switch, and what happens when it is half-thrown.
 *
 * A hub whose Matrix configuration is incomplete must still boot and serve its
 * fleet — the bridge is an addition to a facilities console, not a dependency of
 * one. So the failure mode is a warning and a bridge that does not run, never a
 * hub that will not start.
 */

const base = {
  ENABLE_MATRIX_BRIDGE: "true",
  MATRIX_HOMESERVER_URL: "http://127.0.0.1:6167",
  MATRIX_SERVER_NAME: "id.agentpod.dev",
  MATRIX_AS_TOKEN: "as-token",
  MATRIX_HS_TOKEN: "hs-token",
} as unknown as NodeJS.ProcessEnv;

describe("the bridge switch", () => {
  test("is off unless the flag is the literal lowercase true", () => {
    // `=1`, `TRUE` and `yes` are off. This codebase has already learned that a
    // looser boolean passes boot validation and starts nothing — the worst of
    // both, because it looks configured.
    for (const value of ["1", "TRUE", "yes", "True", ""]) {
      expect(matrixBridgeConfig({ ...base, ENABLE_MATRIX_BRIDGE: value }).enabled).toBe(false);
    }
    expect(matrixBridgeConfig(base).enabled).toBe(true);
  });

  test("names what is missing rather than starting half-configured", () => {
    const cfg = matrixBridgeConfig({ ...base, MATRIX_AS_TOKEN: "", MATRIX_HS_TOKEN: "" });
    expect(matrixBridgeProblems(cfg)).toEqual(["MATRIX_AS_TOKEN", "MATRIX_HS_TOKEN"]);
  });

  test("complains about nothing when it is switched off", () => {
    // An operator who has not enabled the bridge should not be told about
    // variables they were never asked for.
    const cfg = matrixBridgeConfig({ ...base, ENABLE_MATRIX_BRIDGE: "false" });
    expect(matrixBridgeProblems(cfg)).toEqual([]);
  });

  test("builds nothing when off, so no route can answer a homeserver", () => {
    expect(createMatrixBridge(matrixBridgeConfig({ ...base, ENABLE_MATRIX_BRIDGE: "false" }))).toBeNull();
  });

  test("builds nothing when enabled but unconfigured", () => {
    // Null rather than a half-built bridge: mounting routes that answered a
    // homeserver we have no token for would be worse than not answering.
    expect(createMatrixBridge(matrixBridgeConfig({ ...base, MATRIX_HS_TOKEN: "" }))).toBeNull();
  });

  test("builds when it has everything", () => {
    const bridge = createMatrixBridge(matrixBridgeConfig(base));
    expect(bridge).not.toBeNull();
    expect(bridge!.config.domain).toBe("id.agentpod.dev");
  });

  test("defaults the homeserver to loopback, because it is never remote here", () => {
    const cfg = matrixBridgeConfig({ ...base, MATRIX_HOMESERVER_URL: undefined });
    expect(cfg.homeserverUrl).toBe("http://127.0.0.1:6167");
  });
});
