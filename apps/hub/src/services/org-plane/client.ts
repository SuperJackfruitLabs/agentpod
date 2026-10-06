/**
 * Every call the hub makes to the organization plane, in one place, authenticated with the
 * hub's own `svc_` credential (contract §3, §3.4, §3.4b, §3.5). A shape change at the plane is a
 * change here only.
 *
 * The credential is sent as `Authorization: Bearer <svc id>:<secret>` and appears nowhere else:
 * not in an error, not in a log line. A network failure or timeout is `OrgPlaneError(0,
 * "unreachable")`; the underlying error is dropped on purpose, because a fetch error can quote
 * its request.
 */
import { orgPlane, type OrgPlaneConfig, type ServiceCredential } from "../../auth/org-plane/config";

export class OrgPlaneError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`org plane answered ${status === 0 ? "nothing" : status} (${code})`);
    this.name = "OrgPlaneError";
  }
}

export interface PlaneGrant {
  mayDispatch: string[];
  mayGrantReach: boolean;
  scopes: string[];
}
export type PlaneKind = "human" | "agent" | "service";
/** Contract §3.5, `GET /api/principals/:id`. */
export interface PlanePrincipal {
  id: string;
  kind: PlaneKind;
  handle: string;
  displayName: string | null;
  organizationId: string | null;
  suspended: boolean;
  grant: PlaneGrant | null;
}
export interface PlaneIdentity {
  principalId: string;
  kind: PlaneKind;
  suspended: boolean;
}
export interface PlaneToken {
  accessToken: string;
  expiresIn: number;
}

export interface OrgPlaneClient {
  /** Contract §3.4. `audience` is a string or an array of resources. */
  agentToken(principal: string, audience: string | string[]): Promise<PlaneToken>;
  /** Contract §3.4b. The plane resolves the human from the identity; the hub never names a prn_. */
  assertionToken(identity: { system: string; externalId: string }, audience: string): Promise<PlaneToken>;
  createAgent(input: { handle: string; displayName: string }): Promise<{ id: string }>;
  putGrant(id: string, grant: PlaneGrant): Promise<void>;
  linkIdentity(id: string, system: string, externalId: string): Promise<void>;
  /** Null when the plane knows no such identity (404). */
  lookupIdentity(system: string, externalId: string): Promise<PlaneIdentity | null>;
  /** Null when the plane knows no such principal (404). */
  getPrincipal(id: string): Promise<PlanePrincipal | null>;
  listPrincipals(kind: PlaneKind): Promise<PlanePrincipal[]>;
  suspend(id: string): Promise<void>;
  unsuspend(id: string): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Answer = { status: number; json: any };

export function createOrgPlaneClient(o: {
  url: string;
  credential: ServiceCredential;
  fetch?: Fetch;
  timeoutMs?: number;
}): OrgPlaneClient {
  const doFetch: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = o.timeoutMs ?? 5_000;
  const base = o.url.replace(/\/+$/, "");
  const authorization = `Bearer ${o.credential.id}:${o.credential.secret}`;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body?: unknown): Promise<Answer> {
    let res: Response;
    let text: string;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch {
      // Deliberately not chained: the cause can quote the request, and the request carries the secret.
      throw new OrgPlaneError(0, "unreachable");
    }
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  function ok(r: Answer, allowNotFound = false): any {
    if (r.status >= 200 && r.status < 300) return r.json;
    if (allowNotFound && r.status === 404) return null;
    throw new OrgPlaneError(r.status, typeof r.json?.error === "string" ? r.json.error : "error");
  }

  function token(r: Answer): PlaneToken {
    const j = ok(r);
    if (typeof j?.access_token !== "string" || j.access_token === "" || typeof j?.expires_in !== "number") {
      throw new OrgPlaneError(r.status, "malformed_response");
    }
    return { accessToken: j.access_token, expiresIn: j.expires_in };
  }

  return {
    agentToken: async (principal, audience) => token(await call("POST", "/api/token/agent", { principal, audience })),
    assertionToken: async (identity, audience) =>
      token(
        await call("POST", "/api/token/assertion", {
          identity: { system: identity.system, externalId: identity.externalId },
          audience,
        }),
      ),
    createAgent: async ({ handle, displayName }) => {
      const r = await call("POST", "/api/principals", { kind: "agent", handle, displayName });
      const j = ok(r);
      if (typeof j?.id !== "string" || j.id === "") throw new OrgPlaneError(r.status, "malformed_response");
      return { id: j.id };
    },
    putGrant: async (id, grant) =>
      void ok(
        await call("PUT", `/api/principals/${enc(id)}/grants`, {
          mayDispatch: grant.mayDispatch,
          mayGrantReach: grant.mayGrantReach,
          scopes: grant.scopes,
        }),
      ),
    linkIdentity: async (id, system, externalId) =>
      void ok(await call("PUT", `/api/principals/${enc(id)}/identities/${enc(system)}`, { externalId })),
    lookupIdentity: async (system, externalId) =>
      ok(await call("GET", `/api/identities/${enc(system)}/${enc(externalId)}`), true),
    getPrincipal: async (id) => ok(await call("GET", `/api/principals/${enc(id)}`), true),
    listPrincipals: async (kind) => ok(await call("GET", `/api/principals?kind=${enc(kind)}`)) ?? [],
    suspend: async (id) => void ok(await call("POST", `/api/principals/${enc(id)}/suspend`)),
    unsuspend: async (id) => void ok(await call("POST", `/api/principals/${enc(id)}/unsuspend`)),
  };
}

let singleton: { plane: OrgPlaneConfig; client: OrgPlaneClient } | null = null;
let testOverride: OrgPlaneClient | null = null;

/** The client for the configured plane. Throws in legacy mode: no legacy path may reach the plane. */
export function orgPlaneClient(): OrgPlaneClient {
  if (testOverride) return testOverride;
  const plane = orgPlane();
  if (!plane) throw new Error("orgPlaneClient() called with ORG_PLANE_* unset");
  if (singleton?.plane !== plane) {
    singleton = { plane, client: createOrgPlaneClient({ url: plane.url, credential: plane.serviceCredential }) };
  }
  return singleton.client;
}

export function setOrgPlaneClientForTests(c: OrgPlaneClient | null): () => void {
  const previous = testOverride;
  testOverride = c;
  return () => {
    testOverride = previous;
  };
}
