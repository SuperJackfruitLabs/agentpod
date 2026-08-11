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
  /** Preferred: a session cookie lifted from the browser. No password anywhere. */
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

export function loadConfig(): SpikeConfig {
  const hubCookie = process.env.HUB_COOKIE?.trim() || undefined;
  const hubEmail = process.env.HUB_EMAIL?.trim() || undefined;
  const hubPassword = process.env.HUB_PASSWORD?.trim() || undefined;

  if (!hubCookie && !(hubEmail && hubPassword)) {
    throw new Error(
      "hub auth missing — set HUB_COOKIE (preferred: copy the session cookie from the " +
        "console's devtools) or both HUB_EMAIL and HUB_PASSWORD. See README.md.",
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
