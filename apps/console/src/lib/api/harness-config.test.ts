/**
 * harness-config.test.ts
 *
 * The console's client for declared harness configuration — the panel this
 * feeds (Tasks 2-4) is a reader and a reviewer; it never invents a second
 * apply path, so this client must carry through exactly what the hub says:
 * which URL/method each call hits, and — the one requirement that matters
 * most here — a refused plan's `code` and `message`, told apart from a 502
 * (the station could not be reached), which is a different situation and
 * must never read as a refusal.
 *
 * Two mocking styles, both already used elsewhere in this directory:
 *   - `vi.spyOn(client, "http")` (as `plugins.test.ts`/`skills.test.ts` do)
 *     for "this call hits this URL with this body" — it bypasses fetch, so
 *     it cannot exercise error construction.
 *   - A stubbed `globalThis.fetch` (as `acp.test.ts`/`unauthorized.test.ts`
 *     do) for the refusal/unreachable tests, which must go through the real
 *     `http()` → `apiError()` path to prove what a caller actually receives.
 *
 * Run: cd apps/console && pnpm test src/lib/api/harness-config.test.ts
 */
import { test, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConfigObservation, ConfigPlan, ConfigReceipt, ConfigSetting } from "@agentpod/contract";
import * as client from "./client";
import { ApiError } from "./http-error";
import * as cfg from "./harness-config";

// ─── Fixtures ─────────────────────────────────────────────────────────────

const setting: ConfigSetting = {
  id: "hermes.command_timeout_ms",
  harness: "hermes",
  scope: "profile",
  policy: "reconcilable",
  restartToTakeEffect: false,
};

const observation: ConfigObservation = {
  settingId: setting.id,
  stationId: "station_1",
  declared: 900,
  observed: 300,
  state: "drifted",
};

const plan: ConfigPlan = {
  schemaVersion: 1,
  operationId: "op_1",
  stationKey: "hermes:fixture",
  entries: [
    {
      settingId: setting.id,
      file: "/profiles/fixture/config.yaml",
      keyPath: "command_timeout_ms",
      policy: "reconcilable",
      current: 300,
      intended: 900,
      action: "modify",
      restartToTakeEffect: false,
    },
  ],
  beforeSha256: "a".repeat(64),
  diff: "-command_timeout_ms: 300\n+command_timeout_ms: 900\n",
  diffTruncated: false,
  noOp: false,
  restartRequired: false,
  createdAt: "2026-10-05T00:00:00.000Z",
  planDigest: "digest_1",
};

const receipt: ConfigReceipt = {
  plan,
  phase: "applied",
  updatedAt: "2026-10-05T00:00:01.000Z",
  written: [{ settingId: setting.id, action: "modify", wrote: 900 }],
};

// ─── Spy-on-client.http tests: each call hits the right URL and method ────

afterEach(() => vi.restoreAllMocks());

test("listConfigSettings GETs /api/fleet/config/settings", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue({ settings: [setting], unreachableNodes: [] });
  const result = await cfg.listConfigSettings();
  expect(http).toHaveBeenCalledWith("/api/fleet/config/settings");
  expect(result).toEqual({ settings: [setting], unreachableNodes: [] });
});

test("getStationConfig GETs /api/stations/:stationId/config", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue({ observations: [observation] });
  const result = await cfg.getStationConfig("station_1");
  expect(http).toHaveBeenCalledWith("/api/stations/station_1/config");
  expect(result).toEqual({ observations: [observation] });
});

test("planStationConfig POSTs {settings:[{settingId}]} to .../config/plan, never sending a value", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(plan);
  const result = await cfg.planStationConfig("station_1", [setting.id, "hermes.other"]);
  expect(http).toHaveBeenCalledWith("/api/stations/station_1/config/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: [{ settingId: setting.id }, { settingId: "hermes.other" }] }),
  });
  expect(result).toEqual(plan);
});

test("planStationConfig with no settingIds plans every setting currently declared for the station", async () => {
  // Mirrors the CLI's own default (`fleet config plan --station ID` with no
  // SETTING_ID): fetch this station's observations first, dedupe their
  // settingIds, and plan over exactly those — never an empty request.
  const http = vi.spyOn(client, "http").mockImplementation(async (path) => {
    if (path === "/api/stations/station_1/config") {
      return {
        observations: [
          observation,
          { ...observation, settingId: "hermes.other" },
          { ...observation, settingId: setting.id }, // duplicate settingId across observations
        ],
      };
    }
    return plan;
  });

  await cfg.planStationConfig("station_1");

  expect(http).toHaveBeenCalledTimes(2);
  expect(http).toHaveBeenNthCalledWith(2, "/api/stations/station_1/config/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ settings: [{ settingId: setting.id }, { settingId: "hermes.other" }] }),
  });
});

test("inspectConfigOperation GETs .../config/operations/:operationId", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(receipt);
  const result = await cfg.inspectConfigOperation("station_1", "op_1");
  expect(http).toHaveBeenCalledWith("/api/stations/station_1/config/operations/op_1");
  expect(result).toEqual(receipt);
});

test("applyStationConfig POSTs {operationId, planDigest} to .../config/apply — the digest from the DISPLAYED plan", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue(receipt);
  const result = await cfg.applyStationConfig("station_1", "op_1", "digest_1");
  expect(http).toHaveBeenCalledWith("/api/stations/station_1/config/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "op_1", planDigest: "digest_1" }),
  });
  expect(result).toEqual(receipt);
});

test("listConfigOptOuts with no filter GETs the bare path", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue([]);
  await cfg.listConfigOptOuts();
  expect(http).toHaveBeenCalledWith("/api/fleet/config/opt-out");
});

test("listConfigOptOuts narrows by stationKey or nodeId as query params", async () => {
  const http = vi.spyOn(client, "http").mockResolvedValue([]);
  await cfg.listConfigOptOuts({ stationKey: "hermes:fixture" });
  expect(http).toHaveBeenCalledWith("/api/fleet/config/opt-out?stationKey=hermes%3Afixture");

  await cfg.listConfigOptOuts({ nodeId: "node_1" });
  expect(http).toHaveBeenCalledWith("/api/fleet/config/opt-out?nodeId=node_1");
});

// ─── Real fetch: a refused plan is an answer, not an exception ────────────

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  localStorage.setItem("agentpod.apiUrl", "http://hub.test:3001");
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

test("a 400 refusal surfaces its code and message — OPTED_OUT", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({ error: "an operator exempted this setting for this station", code: "OPTED_OUT" }, 400),
    ),
  );

  const failure = await cfg.planStationConfig("station_1", [setting.id]).then(
    () => null,
    (e: unknown) => e,
  );

  expect(failure).toBeInstanceOf(ApiError);
  const err = failure as ApiError;
  expect(err.status).toBe(400);
  expect(err.code).toBe("OPTED_OUT");
  expect(err.message).toBe("An operator exempted this setting for this station.");
});

test("a 400 refusal surfaces its code and message — CREDENTIAL_PATH, distinct from OPTED_OUT", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(jsonResponse({ error: "this key path is a credential file", code: "CREDENTIAL_PATH" }, 400)),
  );

  const err = (await cfg.planStationConfig("station_1", [setting.id]).catch((e: unknown) => e)) as ApiError;

  expect(err.code).toBe("CREDENTIAL_PATH");
  expect(err.code).not.toBe("OPTED_OUT");
  expect(err.message).toBe("This key path is a credential file.");
});

test("a 409 document-state refusal surfaces its code too — PLAN_DIGEST_MISMATCH", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({ error: "the digest does not match the recorded plan", code: "PLAN_DIGEST_MISMATCH" }, 409),
    ),
  );

  const err = (await cfg.applyStationConfig("station_1", "op_1", "stale-digest").catch((e: unknown) => e)) as ApiError;

  expect(err.status).toBe(409);
  expect(err.code).toBe("PLAN_DIGEST_MISMATCH");
});

test("a 502 surfaces as the station being unreachable, not as a refusal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      jsonResponse({ error: "the node could not be reached to confirm its setting registry", code: "NODE_UNREACHABLE" }, 502),
    ),
  );

  const err = (await cfg.planStationConfig("station_1", [setting.id]).catch((e: unknown) => e)) as ApiError;

  // The status is what a caller must branch on to show "unreachable" rather
  // than "refused" — a 502 is never one of the plan route's refusal statuses
  // (400/409), regardless of whether a code happens to ride along with it.
  expect(err.status).toBe(502);
  expect(err.message).toBe("The node could not be reached to confirm its setting registry.");
  expect(err.message).not.toMatch(/declared|exempt|credential|scope/i);
});

test("a 502 with no code at all (the inspect route's shape) still reads as unreachable, not a generic failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "the node could not be reached" }, 502)));

  const err = (await cfg.inspectConfigOperation("station_1", "op_1").catch((e: unknown) => e)) as ApiError;

  expect(err.status).toBe(502);
  expect(err.code).toBeUndefined();
  expect(err.message).toBe("The node could not be reached.");
});
