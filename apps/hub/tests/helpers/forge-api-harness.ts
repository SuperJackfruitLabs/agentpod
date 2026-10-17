/**
 * Shared fixtures for the forge API reassignment and reconcile tests: a scripted provider and
 * broker, stations on a test node, and the leak check (every minted secret is looked for in the
 * console sink, station_audit, the grant rows, every node frame, every error and the reports).
 *
 * The sealer is a fake that never sees anything but the material object and returns a fixed
 * envelope: these tests are about lifecycle and scheduling, not cryptography, and a fake keeps
 * libsodium out of their import graph.
 */
import { spyOn } from "bun:test";
import { eq } from "drizzle-orm";

import { db, rawSql } from "../../src/db/drizzle";
import { stationForgeApiGrants as g, type StationForgeApiGrant } from "../../src/db/schema/forge-api-grants";
import { getProvider, type ForgeProvider } from "../../src/services/forge-api/providers";
import { githubProvider } from "../../src/services/forge-api/github";
import type { ForgeApiDeps } from "../../src/services/station-forge-api";
import { createPrincipal } from "./principals";

export const FORGE = "https://forge.recon.test";
export const PUBLIC_KEY = "stk-handover-v1:" + "A".repeat(43);
export const ACK = { ok: true, data: { ok: true, stored: true, isolation: "same-user" } };
export const OFFLINE = { ok: false, error: "node offline" };

type Reply = { ok: boolean; data?: unknown; error?: string };
export type Call = { nodeId: string; verb: string; params: unknown };

const newSecret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");

export function harness(now: () => Date = () => new Date()) {
  const secrets: string[] = [];
  const calls: Call[] = [];
  const minted: { account: string; name: string }[] = [];
  const revoked: { account: string; name: string }[] = [];
  const listed: string[] = [];
  let mintId = 900;
  let login = "";
  /** Per-account provider tokens the scripted forge lists (names only). */
  const tokens = new Map<string, string[]>();
  const replies: Record<string, (params: unknown, nodeId: string) => Reply | Promise<Reply>> = {
    "forge.api.status": () => ({ ok: true, data: { grants: [], publicKey: PUBLIC_KEY } }),
    "forge.api.deliver": () => ACK,
    "forge.api.verify": () => ({ ok: true, data: { ok: true, login, isolation: "separate-user" } }),
    "forge.api.revoke": () => ({ ok: true, data: { removed: true } }),
    "forge.api.policy": () => ({ ok: true, data: { ok: true } }),
  };
  const failRevoke = { accounts: new Set<string>(), all: false };
  const real = getProvider("forgejo", { cfg: { baseUrl: FORGE, adminToken: "admin" } });
  const provider: ForgeProvider = {
    ...real,
    async mint(account, spec) {
      const secret = newSecret();
      secrets.push(secret);
      minted.push({ account, name: spec.name });
      tokens.set(account, [...(tokens.get(account) ?? []), spec.name]);
      return { id: mintId++, name: spec.name, secret };
    },
    async revoke(account, handle) {
      if (failRevoke.all || failRevoke.accounts.has(account)) {
        throw new Error("forge: revoking was refused (HTTP 503).");
      }
      revoked.push({ account, name: handle.name });
      tokens.set(account, (tokens.get(account) ?? []).filter((n) => n !== handle.name));
    },
    async checkToken(account) {
      return { login: account };
    },
    async listTokens(account) {
      listed.push(account);
      return (tokens.get(account) ?? []).map((name) => ({ name }));
    },
  };
  const deps: ForgeApiDeps = {
    db,
    broker: {
      async request(nodeId, verb, params) {
        calls.push({ nodeId, verb, params });
        const r = replies[verb];
        return r ? r(params, nodeId) : { ok: false, error: `unknown verb: ${verb}` };
      },
    },
    providers: (kind) => (kind === "github" ? githubProvider : provider),
    forgeOrigin: FORGE,
    now,
    seal: async (_pk, material) => {
      // Touch the material so a mutation that drops it is visible; never return it.
      if (typeof material.token !== "string" || !material.token) throw new Error("nothing to seal");
      return `stk-handover-v1:${"B".repeat(60)}`;
    },
  };
  return {
    secrets,
    calls,
    minted,
    revoked,
    listed,
    tokens,
    replies,
    provider,
    failRevoke,
    deps,
    setLogin(l: string) {
      login = l;
    },
    callsOf: (verb: string) => calls.filter((c) => c.verb === verb),
    reset() {
      calls.length = 0;
      minted.length = 0;
      revoked.length = 0;
      listed.length = 0;
    },
  };
}
export type Harness = ReturnType<typeof harness>;

export interface Fixture {
  run: string;
  owner: string;
  tenant: string;
  handles: string[];
  seq: number;
}

export async function insertNode(f: Fixture, nodeId: string) {
  await rawSql`
    INSERT INTO nodes (id, tenant_id, user_id, name, hostname, os, arch, cpu_count, status, secret_hash, created_at)
    VALUES (${nodeId}, ${f.tenant}, ${f.owner}, ${`${nodeId}-box`}, 'h', 'linux', 'amd64', 2, 'online', 'x', now())`;
}

export async function insertStation(
  f: Fixture,
  nodeId: string,
  opts: { principalId?: string | null; capabilities?: string[]; parentStationId?: string } = {},
) {
  const id = `station_${f.run}_${f.seq++}`;
  await rawSql`
    INSERT INTO stations (id, tenant_id, user_id, node_id, harness, station_key, kind, display_name, capabilities, principal_id, parent_station_id, adopted_at, created_at)
    VALUES (${id}, ${f.tenant}, ${f.owner}, ${nodeId}, 'claude-code', ${"claude-code:" + id}, 'leaf', ${id},
            ${JSON.stringify(opts.capabilities ?? ["acp", "forge.api"])}::jsonb, ${opts.principalId ?? null}, ${opts.parentStationId ?? null}, now(), now())`;
  return { id, stationKey: "claude-code:" + id };
}

export async function newAgent(f: Fixture) {
  const handle = `${f.run}-agent-${f.seq++}`;
  f.handles.push(handle);
  const principalId = await createPrincipal({ kind: "agent", handle });
  return { principalId, handle };
}

export const loadGrant = async (id: string): Promise<StationForgeApiGrant> =>
  (await db.select().from(g).where(eq(g.id, id)))[0]!;

export function grantInput(f: Fixture, stationId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId: f.tenant,
    stationId,
    actor: f.owner,
    provider: "forgejo" as const,
    instance: FORGE,
    mode: "minted" as const,
    repositories: ["org/repo"],
    preset: "read" as const,
    rules: [],
    allowGraphql: false,
    ...over,
  };
}

/** Capture every console line (the hub logger's sink). Returns the captured lines and a restore. */
export function captureConsole() {
  const lines: string[] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    }),
  );
  return {
    lines,
    restore() {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** No minted secret in any sink: logs, audit rows, grant rows, frames, errors, extra blobs. */
export async function assertNoLeak(
  h: Harness,
  f: Fixture,
  logged: string[],
  extra: unknown[] = [],
): Promise<void> {
  if (h.secrets.length === 0) throw new Error("assertNoLeak: nothing was minted, so nothing was checked");
  const audit = JSON.stringify(await rawSql`SELECT * FROM station_audit WHERE tenant_id = ${f.tenant} AND created_at > now() - interval '1 hour'`);
  const rows = JSON.stringify(await rawSql`SELECT * FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_${f.run}_%`}`);
  const frames = JSON.stringify(h.calls);
  const others = extra.map((e) =>
    e instanceof Error ? `${String(e)} ${JSON.stringify(e, Object.getOwnPropertyNames(e))}` : JSON.stringify(e),
  );
  for (const s of h.secrets) {
    for (const [sink, text] of [
      ["console", logged.join("\n")],
      ["station_audit", audit],
      ["grant rows", rows],
      ["node frames", frames],
      ...others.map((o, i) => [`extra ${i}`, o] as const),
    ] as const) {
      if (text.includes(s)) throw new Error(`a minted token reached ${sink}`);
    }
  }
}
