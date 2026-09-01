/**
 * Route test: `stationMatrixCredentialRoutesFor`, the mount decision
 * `index.ts` makes for `station-matrix-credential.ts`.
 *
 * Fix round 1 finding: `index.ts:173-181`'s
 * `matrixBridge ? createStationMatrixCredentialRoutes({...}) : new Hono()`
 * had zero coverage, because nothing in this suite boots `index.ts` (DB
 * init, the node sweeper, the kaambaan bridge, the real Matrix bridge — all
 * side effects this suite has never wanted). A swapped ternary arm, or an
 * `&&` typo in place of `? :`, would silently make the endpoint vanish for
 * a configured deployment or throw for an unconfigured one, and nothing
 * would catch it.
 *
 * `stationMatrixCredentialRoutesFor` pulls that decision out of `index.ts`
 * into a function `index.ts` now calls rather than inlining — so this test
 * exercises the exact code path index.ts runs, without booting it.
 *
 * No database involved: both cases below are decided before the route ever
 * reaches a query (a request with no `Authorization` header 401s on the
 * bearer-parsing short-circuit; an unmounted path 404s on Hono's own
 * routing). DATABASE_URL is still set first, matching every other file
 * under `src/`, because `station-matrix-credential.ts` imports `db` at
 * module load even though this file never queries it.
 */

// ─── Set env vars BEFORE any src/ imports ─────────────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { describe, expect, test } from "bun:test";

import { stationMatrixCredentialRoutesFor } from "./station-matrix-credential";
import type { MatrixBridge } from "../services/matrix-as/index";

const PATH = "/nodes/some-node/stations/some-station/matrix-credential";

/** Enough of a MatrixBridge to satisfy the type — its methods are never
 * actually invoked by these tests, since both requests below are refused
 * before the handler would reach them. */
const fakeBridge = {
  client: {
    registerWithCredentials: async () => {
      throw new Error("not exercised by this test");
    },
    rotateCredentials: async () => {
      throw new Error("not exercised by this test");
    },
  },
} as unknown as MatrixBridge;

describe("stationMatrixCredentialRoutesFor", () => {
  test("a configured bridge mounts the route — an unauthenticated request reaches it and is refused with 401, not 404", async () => {
    const res = await stationMatrixCredentialRoutesFor(fakeBridge).request(PATH, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("no bridge mounts nothing — the same request 404s rather than 500ing", async () => {
    const res = await stationMatrixCredentialRoutesFor(null).request(PATH, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });
});
