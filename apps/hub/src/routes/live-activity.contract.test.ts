/**
 * The Live Activity token routes against treaty's OpenAPI document
 * (`schemas/http/agentpod/live-activity.v1.openapi.json`, treaty phase 2, ruling 7): every valid
 * request case is accepted with a response the document describes, every invalid one is refused
 * with one, and every refusal the routes can make (401, 413, 502, 503) is the contract's
 * `matrix-error.v1` envelope. Checked with treaty-contracts' `validateRequest` / `validateResponse`,
 * as phase 1's hook checks the hub's calls to SuperPipeline.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { openApi, validateRequest, validateResponse, type Cases } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

import { treatyText } from "../../tests/helpers/treaty-data";
import { createLiveActivityRoutes, createWhoami } from "./live-activity";
import { createFleetService, type FleetService } from "../services/push/fleet/service";
import { memoryLiveActivityTokenStore } from "../services/push/fleet/tokens";

const bundle = loadInstalledBundle();
const DOC = "schemas/http/agentpod/live-activity.v1.openapi.json";
const api = openApi(bundle, DOC);
const corpus: { operations: Record<string, { request: Cases }> } = JSON.parse(
  treatyText("fixtures/http/agentpod/live-activity.v1.cases.json"),
);

const GOOD = "syt_good_token";
const OPS = { registerLiveActivityToken: "POST", removeLiveActivityToken: "DELETE" } as const;
type Op = keyof typeof OPS;
const OP_NAMES: Op[] = ["registerLiveActivityToken", "removeLiveActivityToken"];
const BEARER = "Bearer " + GOOD;

let fleet: FleetService;
let homeserver: () => Response;

beforeEach(() => {
  homeserver = () => Response.json({ user_id: "@owner:id.agentpod.dev", device_id: "ABCDEFGHIJ" });
  fleet = createFleetService({
    apns: { send: async () => ({ status: "sent" }) },
    tokens: memoryLiveActivityTokenStore(),
    setTimer: () => () => {},
  });
});

function app(opts: { fleet?: FleetService | null } = {}) {
  return new Hono().route(
    "/_supermessage/v1/live-activity",
    createLiveActivityRoutes({
      fleet: opts.fleet === undefined ? fleet : opts.fleet,
      whoami: createWhoami({
        homeserverUrl: "http://127.0.0.1:6167",
        fetch: async (_url, init) =>
          new Headers(init?.headers).get("authorization") === BEARER
            ? homeserver()
            : Response.json({ errcode: "M_UNKNOWN_TOKEN", error: "Unknown access token" }, { status: 401 }),
      }),
    }),
  );
}

/** A call, and the contract's word on the response it got. */
async function call(op: Op, body: unknown, opts: { auth?: string; fleet?: FleetService | null; raw?: string } = {}) {
  const res = await app({ fleet: opts.fleet }).request("/_supermessage/v1/live-activity/tokens", {
    method: OPS[op],
    headers: { "content-type": "application/json", authorization: opts.auth ?? BEARER },
    body: opts.raw ?? JSON.stringify(body),
  });
  const text = await res.text();
  const parsed: unknown = text === "" ? undefined : JSON.parse(text);
  return { status: res.status, body: parsed, contract: validateResponse(bundle, api, op, res.status, parsed) };
}

for (const op of OP_NAMES) {
  const cases = corpus.operations[op]?.request;
  if (!cases) throw new Error(`treaty has no cases for ${op}`);

  describe(op, () => {
    for (const [name, body] of Object.entries(cases.valid)) {
      test(`accepts ${name}`, async () => {
        expect(validateRequest(bundle, api, op, body).errors).toEqual([]);
        const got = await call(op, body);
        expect(got.status).toBe(204);
        expect(got.contract.errors).toEqual([]);
      });
    }

    for (const { why, body } of cases.invalid) {
      test(`refuses ${why}`, async () => {
        expect(validateRequest(bundle, api, op, body).valid).toBe(false);
        const got = await call(op, body);
        expect(got.status).toBe(400);
        expect(got.contract.errors).toEqual([]);
      });
    }

    const valid = Object.values(cases.valid)[0];

    test("a token the homeserver does not know is 401, in the contract's envelope", async () => {
      const got = await call(op, valid, { auth: "Bearer syt_someone_else" });
      expect(got.status).toBe(401);
      expect(got.contract.errors).toEqual([]);
    });

    test("an unreachable homeserver is 502, in the contract's envelope", async () => {
      homeserver = () => new Response("down", { status: 503 });
      const got = await call(op, valid);
      expect(got.status).toBe(502);
      expect(got.contract.errors).toEqual([]);
    });

    test("no push gateway is 503, in the contract's envelope", async () => {
      const got = await call(op, valid, { fleet: null });
      expect(got.status).toBe(503);
      expect(got.contract.errors).toEqual([]);
    });

    test("a body over the limit is 413, in the contract's envelope", async () => {
      const got = await call(op, undefined, { raw: JSON.stringify({ kind: "start", device_id: "D", pad: "x".repeat(64 * 1024) }) });
      expect(got.status).toBe(413);
      expect(got.contract.errors).toEqual([]);
    });
  });
}
