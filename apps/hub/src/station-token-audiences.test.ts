/**
 * Which planes a station token may be spent at.
 *
 * A station token is how an agent holds no long-lived credential of its own: the node proved itself
 * once at enrollment and spends that proof on a station's behalf. Its claims were always right —
 * `sub` is the station's principal, `principalKind: 'agent'`, `mayDispatch` off the grant table —
 * and its `aud` was always the HUB alone, because the mint passed no `audiences` and
 * `signServiceToken` falls back to `config.publicUrl`.
 *
 * So superpipeline refused every one of them (it demands `aud` contain its own `APP_URL`), and the
 * `HUB_OAUTH_CLIENTS` fix could never reach this route: it consults no client, and conceptually has
 * none — the caller is a node spending a secret, not an OAuth client.
 *
 * Nothing consumed the route yet, which is why a wrong audience never bit.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

const ENV = "WORK_PLANE_AUDIENCES";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/** Re-read the module so the env var is picked up — `config.ts` reads env at import time. */
async function audiences(value: string | undefined): Promise<string[]> {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  const mod = await import(`./config.ts?aud=${encodeURIComponent(String(value))}`);
  return mod.STATION_TOKEN_AUDIENCES as string[];
}

describe("STATION_TOKEN_AUDIENCES", () => {
  test("is the hub alone when nothing is configured", async () => {
    // The pre-existing behaviour, kept exactly: a deployment that never asked for a work plane gets
    // the value `signServiceToken` already fell back to, so nothing changes under it.
    const { HUB_AUDIENCE } = await import("./config.ts");
    expect(await audiences(undefined)).toEqual([HUB_AUDIENCE]);
  });

  test("adds a configured work plane, and keeps the hub", async () => {
    // The hub is always in. An agent holding a station token talks to the hub constantly — MCP
    // self-reporting is live — so a list that replaced the hub would break its own agents.
    const { HUB_AUDIENCE } = await import("./config.ts");
    const got = await audiences("https://app.superpipeline.dev");
    expect(got[0]).toBe(HUB_AUDIENCE);
    expect(got).toContain("https://app.superpipeline.dev");
    expect(got).toHaveLength(2);
  });

  test("takes several planes, trimmed", async () => {
    const got = await audiences(" https://a.test , https://b.test ");
    expect(got).toContain("https://a.test");
    expect(got).toContain("https://b.test");
  });

  test("never lists the hub twice, however it is spelled in the env", async () => {
    // An operator naming the hub explicitly is being helpful, not wrong; a duplicate `aud` entry is
    // the kind of thing a strict verifier somewhere else would reject.
    const { HUB_AUDIENCE } = await import("./config.ts");
    const got = await audiences(`${HUB_AUDIENCE},https://app.superpipeline.dev`);
    expect(got.filter((a) => a === HUB_AUDIENCE)).toHaveLength(1);
  });

  test("ignores empty entries, so a trailing comma is not an empty audience", async () => {
    // An empty string in `aud` would be an audience nothing can ever match, silently locking the
    // token out of the plane the operator was trying to add.
    const got = await audiences("https://a.test,,");
    expect(got).not.toContain("");
    expect(got).toHaveLength(2);
  });
});
