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
  hubEmail: string;
  hubPassword: string;
  stationId: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} — see apps/bridge/spike/README.md`);
  return v;
}

export function loadConfig(): SpikeConfig {
  return {
    kaambaanUrl: process.env.KAAMBAAN_URL ?? "http://localhost:8787",
    tenantId: process.env.TENANT_ID ?? "tnt_dev",
    boardId: req("BOARD_ID"),
    agentToken: req("AGENT_TOKEN"),
    hubUrl: process.env.HUB_URL ?? "https://hub.agentpod.dev",
    hubEmail: req("HUB_EMAIL"),
    hubPassword: req("HUB_PASSWORD"),
    stationId: req("STATION_ID"),
  };
}
