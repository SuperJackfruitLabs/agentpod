/**
 * Spike config. One place for every URL, id and credential so no other module
 * reads process.env directly.
 */

export interface SpikeConfig {
  kaambaanUrl: string;
  tenantId: string;
  boardId: string;
  agentToken: string;
  hubUrl: string;
  /**
   * Preferred. Either the hub's static `API_TOKEN` (a service key mapping to
   * `DEFAULT_USER_ID`) or the value of the `__Secure-better-auth.session_token`
   * cookie — authMiddleware accepts both as `Authorization: Bearer`, and the
   * same value works as `?token=` for the WebSocket handshake.
   */
  hubToken?: string;
  /** Fallback: a full `name=value` cookie pair. */
  hubCookie?: string;
  /** Fallback: email/password sign-in, only used when hubCookie is absent. */
  hubEmail?: string;
  hubPassword?: string;
  stationId: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} — see apps/bridge/spike/README.md`);
  return v;
}

/**
 * Hub-only config. The probe and the auth check talk to the hub and never to
 * kaambaan, so they must not be gated on BOARD_ID/AGENT_TOKEN — those come from
 * a kaambaan seed and would force `wrangler dev` to be running for a check that
 * has nothing to do with it.
 */
export function loadHubConfig(): SpikeConfig {
  const hubToken = process.env.HUB_TOKEN?.trim() || undefined;
  const hubCookie = process.env.HUB_COOKIE?.trim() || undefined;
  const hubEmail = process.env.HUB_EMAIL?.trim() || undefined;
  const hubPassword = process.env.HUB_PASSWORD?.trim() || undefined;

  if (!hubToken && !hubCookie && !(hubEmail && hubPassword)) {
    throw new Error(
      "hub auth missing — set HUB_TOKEN (preferred), or HUB_COOKIE as a full " +
        "name=value pair, or both HUB_EMAIL and HUB_PASSWORD. See README.md.",
    );
  }
  if (hubCookie && !hubCookie.includes("=")) {
    throw new Error(
      "HUB_COOKIE must be a full `name=value` pair. If you have only the value, " +
        "put it in HUB_TOKEN instead — it works as a bearer.",
    );
  }

  return {
    kaambaanUrl: process.env.KAAMBAAN_URL ?? "http://localhost:8787",
    tenantId: process.env.TENANT_ID ?? "tnt_dev",
    boardId: "",
    agentToken: "",
    hubUrl: process.env.HUB_URL ?? "https://hub.agentpod.dev",
    hubToken,
    hubCookie,
    hubEmail,
    hubPassword,
    stationId: req("STATION_ID"),
  };
}

export function loadConfig(): SpikeConfig {
  const hubToken = process.env.HUB_TOKEN?.trim() || undefined;
  const hubCookie = process.env.HUB_COOKIE?.trim() || undefined;
  const hubEmail = process.env.HUB_EMAIL?.trim() || undefined;
  const hubPassword = process.env.HUB_PASSWORD?.trim() || undefined;

  if (!hubToken && !hubCookie && !(hubEmail && hubPassword)) {
    throw new Error(
      "hub auth missing — set HUB_TOKEN (preferred), or HUB_COOKIE as a full " +
        "name=value pair, or both HUB_EMAIL and HUB_PASSWORD. See README.md.",
    );
  }
  if (hubCookie && !hubCookie.includes("=")) {
    throw new Error(
      "HUB_COOKIE must be a full `name=value` pair, e.g. " +
        "`__Secure-better-auth.session_token=abc…`. If you have only the value, " +
        "put it in HUB_TOKEN instead — it works as a bearer.",
    );
  }

  return {
    kaambaanUrl: process.env.KAAMBAAN_URL ?? "http://localhost:8787",
    tenantId: process.env.TENANT_ID ?? "tnt_dev",
    boardId: req("BOARD_ID"),
    agentToken: req("AGENT_TOKEN"),
    hubUrl: process.env.HUB_URL ?? "https://hub.agentpod.dev",
    hubCookie,
    hubEmail,
    hubPassword,
    stationId: req("STATION_ID"),
  };
}
