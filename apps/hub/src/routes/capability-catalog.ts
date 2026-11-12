/**
 * The capability catalog and registry, read by services (charter decision 2026-11-13: AgentPod
 * owns the capability catalog; SuperDispatch reads it).
 *
 * - `GET /api/catalog`: what exists in the caller's workspace (`CatalogEntry[]`).
 * - `GET /api/catalog/stations`: every station's registry row (`StationCapabilities[]`).
 * - `GET /api/catalog/stations/:id`: one station's row, or 404.
 *
 * Reads only, names only: no secret, token or credential value is ever in an answer.
 *
 * Mounted ahead of `authMiddleware` and resolving its own auth, like the roster read
 * (`bridge-roster.ts`): the caller is a service, which `authMiddleware` refuses. Which services
 * may read is `CATALOG_READERS` (comma-separated principal ids), read at request time; unset, no
 * service may.
 */
import { Hono, type Context } from "hono";

import { verifyPlaneBearer } from "../auth/hub-token";
import {
  catalogFrom,
  stationCapabilities,
  stationFactsFor,
  type CatalogEntry,
  type StationCapabilities,
} from "../services/catalog";

const STATION = /^[A-Za-z0-9_-]{1,100}$/;

export interface CapabilityCatalogDeps {
  verify: (token: string) => ReturnType<typeof verifyPlaneBearer>;
  readers: () => string[];
  catalog: (tenantId: string) => Promise<CatalogEntry[]>;
  stations: (tenantId: string, only?: string[]) => Promise<StationCapabilities[]>;
}

/** The services `CATALOG_READERS` names; none when it is unset. */
export function catalogReaders(env: Record<string, string | undefined> = process.env): string[] {
  return (env.CATALOG_READERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const defaults: CapabilityCatalogDeps = {
  verify: (t) => verifyPlaneBearer(t),
  readers: () => catalogReaders(),
  catalog: async (tenantId) => catalogFrom(await stationFactsFor(tenantId)),
  stations: async (tenantId, only) => (await stationFactsFor(tenantId, only)).map(stationCapabilities),
};

export function createCapabilityCatalogRoute(deps: CapabilityCatalogDeps = defaults) {
  /** The verified, allowlisted service caller, or the refusal to send. */
  async function reader(c: Context): Promise<{ tenantId: string } | Response> {
    const token = /^Bearer +(\S+)$/i.exec((c.req.header("authorization") ?? "").trim())?.[1];
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const r = await deps.verify(token);
    if (!r.ok) return c.json(r.status === 403 ? r.body : { error: "unauthorized" }, r.status);
    if (r.caller.principalKind !== "service" || !deps.readers().includes(r.caller.sub)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return { tenantId: r.caller.tenantId };
  }

  return new Hono()
    .get("/api/catalog", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      return c.json({ entries: await deps.catalog(r.tenantId) });
    })
    .get("/api/catalog/stations", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      return c.json({ stations: await deps.stations(r.tenantId) });
    })
    .get("/api/catalog/stations/:id", async (c) => {
      const r = await reader(c);
      if (r instanceof Response) return r;
      const id = c.req.param("id");
      if (!STATION.test(id)) return c.json({ error: "invalid station" }, 400);
      const [row] = await deps.stations(r.tenantId, [id]);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    });
}
