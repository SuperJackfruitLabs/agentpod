/**
 * The hub's contracted read surfaces against treaty's documents (phase 3): the capability catalog
 * and bridge roster (`capability-catalog.v1`), the fleet list (`fleet.v1`) and the evidence reads
 * (`evidence.v1`). The route tests beside each route (`capability-catalog.test.ts`,
 * `bridge-roster.test.ts`, `fleet-dispatchable.test.ts`, `evidence.test.ts`,
 * `evidence-transcript.test.ts`) answer through `contractChecked`, so every response they get is
 * held to its document. This file adds what they do not reach: every answer the catalog document
 * describes, each one at least once; the fleet list's refusals in RFC 6750's envelope; and an
 * evidence version the hub does not know, refused before anything is read.
 */
import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_CATALOG,
  EVIDENCE,
  FLEET,
  contractChecked,
  contractErrors,
  describedAnswers,
} from "../../tests/helpers/agentpod-contract";
import { OrgPlaneTokenClaims } from "@agentpod/contract";
import type { PlaneBearerResult } from "../auth/hub-token";
import { createBridgeRosterRoute } from "./bridge-roster";
import { createCapabilityCatalogRoute } from "./capability-catalog";
import { createEvidenceRoutes } from "./evidence";
import { createDispatchableRoutes } from "./fleet-dispatchable";

const READER = "prn_0000000000000000c0b3";
const STATION = "stn_00000000000000c1";
const PRN = "prn_000000000000000000a2";
const BOARD = "brd_00000000000000b1";

type Who = "reader" | "stranger" | "person" | "none" | "disabled";

/** A verified token's claims: what the plane signs, with these on top. */
const claimsOf = (extra: Record<string, unknown>): OrgPlaneTokenClaims =>
  OrgPlaneTokenClaims.parse({
    iss: "https://plane.test",
    sub: READER,
    aud: "https://hub.test",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    jti: "jti_1",
    principalKind: "service",
    org: "org_00000000000000000001",
    ent: ["agentpod"],
    mayDispatch: [],
    mayGrantReach: false,
    ...extra,
  });

type Requestable = { request: (p: string, i?: RequestInit) => Response | Promise<Response> };
const getAs = (app: Requestable, path: string, auth = true) =>
  app.request(path, { headers: auth ? { authorization: "Bearer x.y.z" } : {} });

function verdict(who: Who, claims: Record<string, unknown> = {}): PlaneBearerResult {
  if (who === "none") return { ok: false, status: 401 };
  if (who === "disabled") return { ok: false, status: 403, body: { error: "product_not_enabled", org: "org_00000000000000000001" } };
  const principalKind = who === "person" ? "human" : "service";
  const sub = who === "stranger" ? "prn_0000000000000000c0ff" : READER;
  return { ok: true, caller: { sub, principalKind, tenantId: "tnt_1", claims: claimsOf(claims) } };
}

describe("capability-catalog.v1: every answer the document describes", () => {
  const seen = new Set<string>();
  const catalog = (who: Who) =>
    contractChecked(
      createCapabilityCatalogRoute({
        verify: async () => verdict(who),
        readers: () => [READER],
        catalog: async () => [
          { id: "cli:stk", kind: "cli", name: "stk", version: "0.0.9", source: "supertoolkit", licence: "Apache-2.0", credentials: [] },
        ],
        stations: async (_tenant, only) =>
          !only || only.includes(STATION)
            ? [
                {
                  stationId: STATION,
                  principalId: PRN,
                  harness: "hermes",
                  isolation: { level: "host", runtime: null, proof: "declared" },
                  model: null,
                  tools: [],
                  credentials: [],
                },
              ]
            : [],
      }),
      CAPABILITY_CATALOG,
      { seen },
    );
  const roster = (who: Who) =>
    contractChecked(
      createBridgeRosterRoute({
        verify: async () => verdict(who),
        readers: () => [READER],
        boards: async () => [BOARD],
        station: async (_tenant, id) => (id === STATION ? { id, key: "notes-station", owner: "prn_000000000000000000a1" } : null),
        boardRoster: async () => [
          { key: "k", stationId: STATION, principalId: PRN, enabled: true, busy: false, lastDispatchedAt: null, ready: true, reason: null },
        ],
      }),
      CAPABILITY_CATALOG,
      { seen },
    );
  const get = getAs;

  const paths = {
    catalog: ["/api/catalog", "/api/catalog/stations", `/api/catalog/stations/${STATION}`],
    roster: [`/api/bridge/principals/${PRN}/boards`, `/api/bridge/stations/${STATION}`, `/api/bridge/boards/${BOARD}/roster`],
  };

  test("reads, and the refusals every route shares: 401 unauthorized, 403 forbidden and product_not_enabled", async () => {
    for (const [build, list] of [[catalog, paths.catalog], [roster, paths.roster]] as const) {
      for (const path of list) {
        expect((await get(build("reader"), path)).status).toBe(200);
        expect(await (await get(build("reader"), path, false)).json()).toEqual({ error: "unauthorized" });
        expect(await (await get(build("none"), path)).json()).toEqual({ error: "unauthorized" });
        expect(await (await get(build("stranger"), path)).json()).toEqual({ error: "forbidden" });
        expect(await (await get(build("person"), path)).json()).toEqual({ error: "forbidden" });
        expect(await (await get(build("disabled"), path)).json()).toMatchObject({ error: "product_not_enabled" });
      }
    }
  });

  test("a path id out of its form is 400 with its code; a station not in the workspace is 404 not_found", async () => {
    const cases: Array<[Response | Promise<Response>, number, string]> = [
      [get(catalog("reader"), "/api/catalog/stations/bad.id"), 400, "invalid_station"],
      [get(catalog("reader"), "/api/catalog/stations/stn_00000000000000c9"), 404, "not_found"],
      [get(roster("reader"), "/api/bridge/principals/not-a-prn/boards"), 400, "invalid_principal"],
      [get(roster("reader"), "/api/bridge/stations/bad.id"), 400, "invalid_station"],
      [get(roster("reader"), "/api/bridge/stations/stn_00000000000000c9"), 404, "not_found"],
      [get(roster("reader"), "/api/bridge/boards/brd_nothex/roster"), 400, "invalid_board"],
    ];
    for (const [res, status, error] of cases) {
      const r = await res;
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error });
    }
  });

  test("every operation and status the document describes was answered above", () => {
    expect([...seen].toSorted()).toEqual(describedAnswers(CAPABILITY_CATALOG).toSorted());
  });

  test("the old free-text refusals are outside the contract", async () => {
    for (const [status, error] of [[404, "not found"], [400, "invalid station"]] as const) {
      const { errors } = await contractErrors(
        CAPABILITY_CATALOG,
        "GET",
        `/api/bridge/stations/${STATION}`,
        Response.json({ error }, { status }),
      );
      expect(errors).not.toEqual([]);
    }
  });
});

describe("fleet.v1: the fleet list's refusals keep RFC 6750's envelope", () => {
  const seen = new Set<string>();
  const fleet = (who: Who, claims: Record<string, unknown> = {}) =>
    contractChecked(
      createDispatchableRoutes({
        verifyPlane: async () => verdict(who, claims),
        listPrincipals: async () => [
          { id: PRN, kind: "agent", handle: "press-writer", displayName: null, userId: null, suspendedAt: null },
        ],
      }),
      FLEET,
      { seen },
    );
  const get = (app: ReturnType<typeof fleet>, authorization?: string) =>
    app.request("/api/fleet/dispatchable", { headers: authorization ? { authorization } : {} });

  test("a person with a grant reads the agents", async () => {
    const res = await get(fleet("reader", { principalKind: "human", mayDispatch: [PRN] }), "Bearer x.y.z");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agents: [{ id: PRN, handle: "press-writer", displayName: null }] });
  });

  test("no bearer, a token the hub refuses and a non-human token are 401 invalid_token with words", async () => {
    for (const res of [
      await get(fleet("reader")),
      await get(fleet("none"), "Bearer x.y.z"),
      await get(fleet("reader", { principalKind: "agent", mayDispatch: [PRN] }), "Bearer x.y.z"),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token", error_description: expect.any(String) });
    }
  });

  test("an organization without AgentPod is 403 product_not_enabled, naming it", async () => {
    const res = await get(fleet("disabled"), "Bearer x.y.z");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "product_not_enabled", org: "org_00000000000000000001" });
  });

  test("every status the document describes was answered above", () => {
    expect([...seen].toSorted()).toEqual(describedAnswers(FLEET).toSorted());
  });
});

describe("evidence.v1: a schema_version the hub does not know is refused, never read as v1", () => {
  const agent: PlaneBearerResult = {
    ok: true,
    caller: { sub: PRN, principalKind: "agent", tenantId: "tnt_1", claims: claimsOf({ sub: PRN, principalKind: "agent", scope: "evidence:read" }) },
  };
  const app = contractChecked(createEvidenceRoutes({ verifyPlane: async () => agent }), EVIDENCE);
  const get = (path: string) => app.request(path, { headers: { authorization: "Bearer x.y.z" } });

  const routes = [
    ["/api/evidence/runs/superpipeline/run_abcdef/execution", "salaam-execution-evidence/v2"],
    ["/api/evidence/exports/22222222-2222-4222-8222-222222222222", "agentpod-execution-export/v2"],
  ] as const;

  for (const [path, newer] of routes) {
    test(`${path} with ${newer}, none, or one beside another key is 400 unsupported_evidence_version`, async () => {
      const v1 = newer.replace("/v2", "/v1");
      for (const query of [`?schema_version=${encodeURIComponent(newer)}`, "", `?schema_version=${encodeURIComponent(v1)}&schema_version=${encodeURIComponent(newer)}`]) {
        const res = await get(path + query);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "unsupported_evidence_version" });
      }
    });
  }

  test("the refusal comes after authorisation: no token is 401 unauthorized, in flat-error.v1", async () => {
    const anon = contractChecked(createEvidenceRoutes({ verifyPlane: async () => ({ ok: false, status: 401 }) }), EVIDENCE);
    const res = await anon.request(`${routes[0][0]}?schema_version=${encodeURIComponent(routes[0][1])}`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});
