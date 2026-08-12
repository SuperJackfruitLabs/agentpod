/**
 * Unit tests for config.ts — origin allowlist and env parsing.
 * No DB connection required — pure functions only.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { allowedOrigins, isAllowedOrigin, getEnvInt } from "./config";

describe("allowedOrigins (single canonical list)", () => {
  it("contains expected default origins", () => {
    expect(allowedOrigins).toContain("http://localhost:5173");
    expect(allowedOrigins).toContain("https://console.agentpod.dev");
    expect(allowedOrigins).toContain("https://app.agentpod.dev");
  });

  it("is a plain array (not readonly tuple)", () => {
    expect(Array.isArray(allowedOrigins)).toBe(true);
  });
});

describe("isAllowedOrigin", () => {
  it("returns true for origins in the allowedOrigins list", () => {
    expect(isAllowedOrigin("https://console.agentpod.dev")).toBe(true);
    expect(isAllowedOrigin("https://app.agentpod.dev")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
  });

  it("returns false for origins not in the list", () => {
    expect(isAllowedOrigin("https://malicious.com")).toBe(false);
    expect(isAllowedOrigin("http://localhost:9999")).toBe(false);
    expect(isAllowedOrigin("http://localhost:1420")).toBe(false); // removed in P2c (no Tauri); localhost is not a LAN IP
  });

  it("returns true for missing/empty origin (server-to-server, no CSWSH risk)", () => {
    expect(isAllowedOrigin(null)).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("")).toBe(true);
  });

  it("returns true for local LAN IP origins (192.168/10.x, any port — dev)", () => {
    expect(isAllowedOrigin("http://192.168.1.50:5173")).toBe(true);
    expect(isAllowedOrigin("http://10.0.1.2:1420")).toBe(true);
  });
});

/**
 * `getEnvInt` runs at MODULE SCOPE — every value in `config` is computed the
 * moment anything imports this file, long before `validateConfig()` gets a
 * chance to report anything nicely. A throw here is therefore not a validation
 * error but a raw stack trace out of an import, and it is unconditional: it
 * fires for a variable belonging to a substrate the hub has not enabled.
 */
describe("getEnvInt", () => {
  const KEY = "AGENTPOD_TEST_ENV_INT";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("returns the default when the variable is absent", () => {
    expect(getEnvInt(KEY, 3)).toBe(3);
  });

  it("treats a PRESENT BUT EMPTY value as unset", () => {
    // `FLY_VOLUME_SIZE_GB=` is what a copied env block leaves behind — the
    // documented block in docs/DEPLOYMENT.md is a list of commented lines, and
    // uncommenting one without filling it in is a keystroke away. Every deploy
    // platform surfaces an unfilled variable as "" rather than as absent, so
    // "" and absent must mean the same thing: use the default.
    process.env[KEY] = "";
    expect(getEnvInt(KEY, 3)).toBe(3);
  });

  it("treats a whitespace-only value as unset", () => {
    process.env[KEY] = "   ";
    expect(getEnvInt(KEY, 3)).toBe(3);
  });

  it("ignores surrounding whitespace on a real value", () => {
    process.env[KEY] = " 7 ";
    expect(getEnvInt(KEY, 3)).toBe(7);
  });

  it("still refuses a non-numeric value, naming the variable", () => {
    process.env[KEY] = "three";
    expect(() => getEnvInt(KEY, 3)).toThrow(new RegExp(KEY));
  });

});

/**
 * The live-hub hazard, asserted end to end rather than argued.
 *
 * The deployed hub runs docker+cloudflare and has never enabled Fly. Importing
 * config.ts with `FLY_VOLUME_SIZE_GB=` set — and nothing Fly-related enabled —
 * must not be able to stop it booting. A subprocess is the only honest test of
 * module-scope evaluation: this file has already imported config.ts.
 */
describe("config module evaluation", () => {
  const evaluateConfigWith = (env: Record<string, string>) =>
    Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const { config } = await import(${JSON.stringify(`${import.meta.dir}/config.ts`)});` +
          `console.log(JSON.stringify({ volumeSizeGb: config.fly.volumeSizeGb }));`,
      ],
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });

  it("imports cleanly with FLY_VOLUME_SIZE_GB present but empty and Fly disabled", () => {
    const proc = evaluateConfigWith({
      FLY_VOLUME_SIZE_GB: "",
      ENABLE_FLY_PROVISIONING: "false",
    });
    expect(proc.stderr.toString()).not.toMatch(/FLY_VOLUME_SIZE_GB/);
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({ volumeSizeGb: 3 });
  });
});
