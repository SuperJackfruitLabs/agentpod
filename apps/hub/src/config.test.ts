/**
 * Unit tests for config.ts — origin allowlist and env parsing.
 * No DB connection required — pure functions only.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  allowedOrigins,
  isAllowedOrigin,
  getEnvInt,
  parseOAuthClients,
  oauthClients,
  findOAuthClient,
  isRegisteredRedirect,
} from "./config";

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

  it("refuses a FRACTIONAL value rather than silently truncating it", () => {
    // parseInt("3.5") is 3, quietly. An operator who asked for 3.5 GB of
    // workspace and got 3 was never told — and the Fly driver used to parse the
    // same variable with Number(), sending Fly the untruncated 3.5: one
    // variable with two meanings, and a boot check validating a number nothing
    // used. There is one meaning now — whole units, or an error naming the
    // variable.
    process.env[KEY] = "3.5";
    expect(() => getEnvInt(KEY, 3)).toThrow(new RegExp(KEY));
  });

  it("refuses a numeric prefix with trailing junk", () => {
    // parseInt("12gb") is 12 — the same silent half-reading of a value the
    // operator wrote deliberately.
    process.env[KEY] = "12gb";
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

// ─── The OAuth client registry ───────────────────────────────────────────────

/**
 * The registry answers "who may be handed a token", which is a different
 * question from `allowedOrigins`' "who may call us" — so it is parsed and
 * tested separately, and starts empty.
 */
describe("parseOAuthClients", () => {
  it("is empty for an unset variable", () => {
    expect(parseOAuthClients(undefined)).toEqual([]);
  });

  it("is empty for a present but empty variable", () => {
    // Same deployment reality as getEnvInt's "" case: an uncommented but
    // unfilled line must mean "not opted in", not "everything".
    expect(parseOAuthClients("")).toEqual([]);
    expect(parseOAuthClients("   ")).toEqual([]);
  });

  it("parses one client with one redirect URI", () => {
    expect(parseOAuthClients("kaambaan|https://kaambaan.dev/hub/callback")).toEqual([
      { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] },
    ]);
  });

  it("parses several clients", () => {
    expect(
      parseOAuthClients(
        "kaambaan|https://kaambaan.dev/hub/callback,supermessage|https://supermessage.dev/hub/callback",
      ),
    ).toEqual([
      { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] },
      { id: "supermessage", redirectUris: ["https://supermessage.dev/hub/callback"] },
    ]);
  });

  it("merges repeated client keys into one entry with several URIs", () => {
    expect(
      parseOAuthClients(
        "kaambaan|https://kaambaan.dev/hub/callback,kaambaan|http://localhost:5174/hub/callback",
      ),
    ).toEqual([
      {
        id: "kaambaan",
        redirectUris: [
          "https://kaambaan.dev/hub/callback",
          "http://localhost:5174/hub/callback",
        ],
      },
    ]);
  });

  it("does not repeat a URI registered twice for the same client", () => {
    expect(
      parseOAuthClients(
        "kaambaan|https://kaambaan.dev/hub/callback,kaambaan|https://kaambaan.dev/hub/callback",
      ),
    ).toEqual([
      { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] },
    ]);
  });

  it("trims whitespace around every part", () => {
    expect(
      parseOAuthClients(" kaambaan | https://kaambaan.dev/hub/callback , "),
    ).toEqual([{ id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] }]);
  });

  it("skips a malformed entry rather than throwing, and does not widen the rest", () => {
    // A typo in deployment config must not stop the hub booting — but it must
    // not silently become a wildcard either. The good entries survive; the bad
    // one simply is not in the registry, so authorize refuses it.
    const clients = parseOAuthClients(
      [
        "nopipe",                                   // no separator at all
        "|https://nobody.example/hub/callback",     // empty id
        "emptyuri|",                                // empty URI
        "  |  ",                                    // both empty
        "too|many|pipes",                           // ambiguous
        "kaambaan|https://kaambaan.dev/hub/callback",
      ].join(","),
    );
    expect(clients).toEqual([
      { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] },
    ]);
  });
});

describe("findOAuthClient", () => {
  const registry = parseOAuthClients("kaambaan|https://kaambaan.dev/hub/callback");

  it("finds a registered client by exact id", () => {
    expect(findOAuthClient("kaambaan", registry)?.id).toBe("kaambaan");
  });

  it("returns null for an unknown, empty or absent id", () => {
    expect(findOAuthClient("supermessage", registry)).toBeNull();
    expect(findOAuthClient("KAAMBAAN", registry)).toBeNull();
    expect(findOAuthClient("", registry)).toBeNull();
    expect(findOAuthClient(null, registry)).toBeNull();
    expect(findOAuthClient(undefined, registry)).toBeNull();
  });

  it("returns null against the default (empty) registry — a hub that has not opted in", () => {
    expect(oauthClients).toEqual([]);
    expect(findOAuthClient("kaambaan")).toBeNull();
  });
});

describe("isRegisteredRedirect", () => {
  const client = parseOAuthClients(
    "kaambaan|https://kaambaan.dev/hub/callback,kaambaan|http://localhost:5174/hub/callback",
  )[0]!;

  it("accepts an exactly registered URI", () => {
    expect(isRegisteredRedirect(client, "https://kaambaan.dev/hub/callback")).toBe(true);
    expect(isRegisteredRedirect(client, "http://localhost:5174/hub/callback")).toBe(true);
  });

  it("refuses anything that is not the whole string", () => {
    // Prefix matching is how open redirectors are built: every one of these
    // sends the code to somewhere the operator never registered.
    expect(isRegisteredRedirect(client, "https://kaambaan.dev/hub/callback/x")).toBe(false);
    expect(isRegisteredRedirect(client, "https://kaambaan.dev/hub/callback?a=1")).toBe(false);
    expect(isRegisteredRedirect(client, "https://kaambaan.dev/hub/callback#f")).toBe(false);
    expect(isRegisteredRedirect(client, "https://kaambaan.dev/hub/callbac")).toBe(false);
    expect(isRegisteredRedirect(client, "http://kaambaan.dev/hub/callback")).toBe(false);
    expect(isRegisteredRedirect(client, "https://evil.dev/hub/callback")).toBe(false);
    expect(isRegisteredRedirect(client, "https://kaambaan.dev.evil.dev/hub/callback")).toBe(false);
    expect(isRegisteredRedirect(client, " https://kaambaan.dev/hub/callback ")).toBe(false);
    expect(isRegisteredRedirect(client, "")).toBe(false);
  });
});

/**
 * The exported `oauthClients` is computed at module scope, so the only honest
 * test that it reads HUB_OAUTH_CLIENTS at all is a fresh process — this file
 * has already imported config.ts with the variable unset.
 */
describe("oauthClients at module scope", () => {
  it("reads HUB_OAUTH_CLIENTS on import", () => {
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const { oauthClients } = await import(${JSON.stringify(`${import.meta.dir}/config.ts`)});` +
          `console.log(JSON.stringify(oauthClients));`,
      ],
      env: {
        ...process.env,
        HUB_OAUTH_CLIENTS: "kaambaan|https://kaambaan.dev/hub/callback",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual([
      { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] },
    ]);
  });
});
