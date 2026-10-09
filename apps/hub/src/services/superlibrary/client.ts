import { orgPlaneClient, type OrgPlaneClient } from "../org-plane/client";
import { superlibraryConfig } from "./config";
import { createLogger } from "../../utils/logger";

const log = createLogger("superlibrary");

export interface SuperlibraryCaller {
  request(
    method: string,
    path: string,
    init?: { json?: unknown; body?: Uint8Array; contentType?: string; timeoutMs?: number },
  ): Promise<Response>;
}
export interface SuperlibraryClient {
  /**
   * The hub's service token, acting for an agent and nobody else: a person is never named. The
   * agent's own token rides along as proof, which Superlibrary verifies offline.
   */
  asService(onBehalfOf: { principal: string; kind: "agent" }): SuperlibraryCaller;
  /** The agent's own token: what the agent itself may see. */
  asAgent(agentPrincipal: string): SuperlibraryCaller;
  /** Mint and cache the agent's token ahead of its first call. Never throws. */
  warmAgent(agentPrincipal: string): Promise<void>;
  /** Tell Superlibrary a principal's roster changed. Best effort, never throws. */
  invalidateRoster(principal: string): Promise<void>;
}

type Plane = Pick<OrgPlaneClient, "serviceToken" | "agentToken">;

export function createSuperlibraryClient(o: {
  url: string;
  audience: string;
  plane: Plane;
  fetch?: (r: Request) => Promise<Response>;
}): SuperlibraryClient {
  const doFetch = o.fetch ?? ((r: Request) => fetch(r));
  const tokens = new Map<string, { token: string; until: number }>();
  async function tokenFor(key: string, mint: () => Promise<{ accessToken: string; expiresIn: number }>): Promise<string> {
    const hit = tokens.get(key);
    if (hit && hit.until > Date.now()) return hit.token;
    const t = await mint();
    tokens.set(key, { token: t.accessToken, until: Date.now() + (t.expiresIn - 30) * 1000 });
    return t.accessToken;
  }
  const service = () => tokenFor("service", () => o.plane.serviceToken(o.audience));
  const agent = (prn: string) => tokenFor(`agent ${prn}`, () => o.plane.agentToken(prn, o.audience));

  function caller(token: () => Promise<string>, extra: () => Promise<Record<string, string>>): SuperlibraryCaller {
    return {
      async request(method, path, init = {}) {
        const headers = new Headers({ authorization: `Bearer ${await token()}`, ...(await extra()) });
        let body: string | Uint8Array | undefined;
        if (init.json !== undefined) {
          headers.set("content-type", "application/json");
          body = JSON.stringify(init.json);
        } else if (init.body) {
          headers.set("content-type", init.contentType ?? "application/octet-stream");
          body = init.body;
        }
        // Not AbortSignal.timeout: under `bun test` on Bun 1.2.8 it spins the process when it fires
        // through a Request. The timer stays armed after the headers arrive so a stalled body is cut too.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), init.timeoutMs ?? 30_000);
        timer.unref?.();
        try {
          return await doFetch(new Request(`${o.url}${path}`, { method, headers, body, signal: ctl.signal }));
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      },
    };
  }
  const none = async () => ({});
  return {
    asService: (who) =>
      caller(service, async () => ({
        "x-on-behalf-of": who.principal,
        "x-on-behalf-kind": who.kind,
        "x-on-behalf-token": await agent(who.principal),
      })),
    asAgent: (prn) => caller(() => agent(prn), none),
    async warmAgent(prn) {
      try {
        await agent(prn);
      } catch (err) {
        log.warn("superlibrary token warm-up failed", { principal: prn, error: String(err) });
      }
    },
    async invalidateRoster(principal) {
      try {
        const res = await caller(service, none).request("POST", "/api/v1/roster/invalidate", {
          json: { principal },
          timeoutMs: 5_000,
        });
        if (!res.ok) log.warn("roster invalidation refused", { principal, status: res.status });
      } catch (err) {
        log.warn("roster invalidation failed", { principal, error: String(err) });
      }
    },
  };
}

let override: SuperlibraryClient | null | undefined;
let instance: SuperlibraryClient | null | undefined;
export function superlibraryClient(): SuperlibraryClient | null {
  if (override !== undefined) return override;
  if (instance === undefined) {
    const cfg = superlibraryConfig();
    instance = cfg ? createSuperlibraryClient({ ...cfg, plane: orgPlaneClient() }) : null;
  }
  return instance;
}
export function setSuperlibraryClientForTests(c: SuperlibraryClient | null): () => void {
  override = c;
  return () => {
    override = undefined;
  };
}
