/**
 * Characterization: the exact traffic of the station forge API lifecycle, pinned before it splits.
 *
 * The integration suites (station-forge-api*.test.ts, forge-api-*.test.ts) prove the rules one by
 * one. This file pins the WHOLE of what each exported operation does, as it is today, in one
 * ordered trace per scenario, so a restructure that moves the code cannot change any of it
 * unnoticed:
 *
 *   - every provider call (mint, revoke, checkToken) with its arguments,
 *   - every seal call (key and material keys) and every node frame (verb, params, timeout),
 *   - the station's grant rows as they stand at each of those calls (pins each write's order
 *     against the outside calls), and afterwards,
 *   - the audit rows, the module's log lines, and the result or the error (class, code, status,
 *     message, grant id).
 *
 * Ids, run names and timestamps are replaced by placeholders before comparing; the clock is a
 * fixed, injected one, so every time the code computes is pinned exactly. Each test makes its own
 * station (and node), so each passes alone with -t. Uses the local Docker test-postgres.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import { db, rawSql } from "../../db/drizzle";
import { stationForgeApiGrants as g } from "../../db/schema/forge-api-grants";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { createTestUser } from "../../../tests/helpers/database";
import { forgetPrincipals } from "../../../tests/helpers/principals";
import {
  captureConsole,
  grantInput,
  insertNode,
  insertStation,
  newAgent,
  type Fixture,
} from "../../../tests/helpers/forge-api-harness";
import { getProvider, type ForgeProvider } from "./providers";
import { githubProvider } from "./github";
import * as sfa from "./station-forge-api";
import {
  acceptSuppliedSecret,
  confirmSuppliedRevoked,
  createForgeApiGrant,
  deliverGrant,
  markGrantsRevoking,
  registerAppGrant,
  revokeGrant,
  revokeStrayHandles,
  rotateGrant,
  transition,
  undoExpiredRotation,
  updateGrantPolicy,
  verifyGrant,
  type ForgeApiDeps,
} from "./station-forge-api";

const RUN = `fac${crypto.randomUUID().slice(0, 8)}`;
const OWNER = `test-user-${RUN}`;
const FORGE = "https://forge.char.test";
const KEY = "stk-handover-v1:" + "K".repeat(43);
const SUPPLIED = "stk-handover-v1:" + "S".repeat(60);
const T0 = new Date("2030-01-01T00:00:00.000Z");
const f: Fixture = { run: RUN, owner: OWNER, tenant: BOOTSTRAP_TENANT_ID, handles: [], seq: 0 };

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: OWNER, email: `${OWNER}@example.com`, name: "FAC" });
});

afterAll(async () => {
  await rawSql`DELETE FROM station_forge_api_grants WHERE station_id_snapshot LIKE ${`station_${RUN}_%`}`;
  await rawSql`DELETE FROM station_audit WHERE user_id = ${OWNER} OR station_key LIKE ${`%station_${RUN}_%`}`;
  await rawSql`DELETE FROM stations WHERE user_id = ${OWNER}`;
  await rawSql`DELETE FROM nodes WHERE user_id = ${OWNER}`;
  await forgetPrincipals({ handles: f.handles });
});

// ─── Rig ──────────────────────────────────────────────────────────────────────

type Reply = { ok: boolean; data?: unknown; error?: string };
type Scripted = Reply | Error | ((params: unknown) => Reply);

const ACK = (isolation = "separate-user"): Reply => ({ ok: true, data: { ok: true, stored: true, isolation } });
const STATUS = (isolation?: string): Reply => ({
  ok: true,
  data: { publicKey: KEY, grants: isolation ? [{ grantId: "x", present: true, isolation }] : [] },
});

/** A scripted forge, sealer and node that write every call, with the rows at that moment, to `trace`. */
async function rig(opts: { capabilities?: string[]; occupied?: boolean } = {}) {
  const nodeId = `node_${RUN}_${f.seq++}`;
  await insertNode(f, nodeId);
  const agent = opts.occupied === false ? null : await newAgent(f);
  const st = await insertStation(f, nodeId, { principalId: agent?.principalId ?? null, capabilities: opts.capabilities });
  const trace: unknown[] = [];
  let clock = T0;
  let mintId = 900;
  let sealN = 0;
  const secrets: string[] = [];
  const node: Record<string, Scripted[]> = {
    "forge.api.status": [STATUS("separate-user")],
    "forge.api.deliver": [ACK()],
    "forge.api.verify": [],
    "forge.api.revoke": [{ ok: true, data: { removed: true } }],
    "forge.api.policy": [{ ok: true, data: { ok: true } }],
  };
  const mint: (Error | null)[] = [];
  const revoke: (Error | null)[] = [];
  const check: (Error | string)[] = [];
  const seal: (Error | null)[] = [];
  const script = { node, mint, revoke, check, seal };

  const rows = async () =>
    (await db.select().from(g).where(eq(g.stationIdSnapshot, st.id)).orderBy(asc(g.createdAt), asc(g.provider), asc(g.mode), asc(g.id))).map((r) =>
      [
        r.state,
        `g${r.generation}`,
        r.stateReason ?? "-",
        r.tokenHandle ? JSON.stringify(r.tokenHandle) : "no-handle",
        r.sealedBlob ? `blob@${r.sealedExpiresAt?.toISOString()}` : "no-blob",
        r.deliveredAt ? `delivered@${r.deliveredAt.toISOString()}` : "-",
        r.verifiedAt ? `verified@${r.verifiedAt.toISOString()}` : "-",
        r.isolation ?? "-",
        r.policyPendingSince ? "policy-pending" : "-",
        r.sameUserAckAt ? `ack:${r.sameUserAckBy}` : "-",
        `${r.preset}${r.allowGraphql ? "+gql" : ""}:${JSON.stringify(r.rules)}`,
        r.stationId ? "station" : "station-gone",
      ].join(" | "),
    );
  const record = async (...entry: unknown[]) => trace.push([entry.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join(" "), ...(await rows())]);

  const real = getProvider("forgejo", { cfg: { baseUrl: FORGE, adminToken: "admin" } });
  const provider: ForgeProvider = {
    ...real,
    async mint(account, spec) {
      await record("provider.mint", account, spec);
      const fail = next(script.mint);
      if (fail) throw fail;
      const secret = `secret-${RUN}-${mintId}`;
      secrets.push(secret);
      return { id: mintId++, name: spec.name, secret };
    },
    async revoke(account, handle) {
      await record("provider.revoke", account, handle);
      const fail = next(script.revoke);
      if (fail) throw fail;
    },
    async checkToken(account, secret) {
      await record("provider.checkToken", account, secrets.includes(secret) ? "<the minted secret>" : "<other>");
      const r = next(script.check) ?? account;
      if (r instanceof Error) throw r;
      return { login: r };
    },
  };
  const deps: ForgeApiDeps = {
    db,
    broker: {
      async request(to, verb, params, o) {
        await record("node", to === nodeId ? "<node>" : to, verb, params, o ?? null);
        const r = next(script.node[verb] ?? []);
        if (r === undefined) return { ok: false, error: `unknown verb: ${verb}` };
        if (r instanceof Error) throw r;
        return typeof r === "function" ? r(params) : r;
      },
    },
    providers: (kind) => (kind === "github" ? githubProvider : provider),
    forgeOrigin: FORGE,
    now: () => clock,
    seal: async (pk, material) => {
      await record("seal", pk, Object.keys(material), secrets.includes(material.token ?? "") ? "<the minted secret>" : "<other>");
      const fail = next(script.seal);
      if (fail) throw fail;
      return `stk-handover-v1:SEALED${++sealN}`;
    },
  };

  const names: Record<string, string> = { [RUN]: "<run>", [nodeId]: "<node>", [st.id]: "<station>" };
  if (agent) Object.assign(names, { [agent.principalId]: "<occupant>", [agent.handle]: "<occupant-handle>" });
  let gN = 0;
  /** Replace ids, run names, secrets and wall-clock times with placeholders. */
  const normalize = (value: unknown): unknown => {
    let text = JSON.stringify(value, (_k, v) => (v === undefined ? "<undefined>" : v));
    for (const s of secrets) text = text.split(s).join("<SECRET LEAKED>");
    for (const id of new Set(text.match(/fag_[0-9a-f]{32}/g) ?? [])) {
      const label = names[id] ?? `<grant${++gN}>`;
      names[id] = label;
      names[id.replace(/[^a-zA-Z0-9]/g, "").slice(-12).toLowerCase()] = `${label.slice(0, -1)}-tail>`;
    }
    for (const [literal, name] of Object.entries(names).toSorted((a, b) => b[0].length - a[0].length)) {
      text = text.split(literal).join(name);
    }
    return JSON.parse(text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, (t) => (t.startsWith("203") ? t : "<time>")));
  };

  /** Run one operation and return everything it did. */
  const run = async (fn: () => Promise<unknown>) => {
    trace.length = 0;
    const con = captureConsole();
    let outcome: unknown;
    try {
      outcome = { ok: summarize(await fn()) };
    } catch (err) {
      outcome = { error: describeError(err) };
    } finally {
      con.restore();
    }
    const logs = con.lines.flatMap((line) => {
      const l = LogLine.safeParse(parseJson(line)).data;
      if (l?.component !== "station-forge-api") return [];
      return [`${l.level} ${l.message}${l.context ? ` ${JSON.stringify(l.context)}` : ""}`];
    });
    const audit = await rawSql`
      SELECT verb, result, error, params_summary FROM station_audit
      WHERE station_key = ${st.stationKey} AND created_at > now() - interval '1 minute'
      ORDER BY created_at, verb, params_summary->>'provider'`;
    await rawSql`DELETE FROM station_audit WHERE station_key = ${st.stationKey}`;
    const audits = [...audit].map((a) => `${a.verb} ${a.result}${a.error ? ` (${a.error})` : ""} ${JSON.stringify(a.params_summary)}`)
      // markGrantsRevoking walks its rows in no fixed order, so the audit rows are compared as a set.
      .toSorted();
    return normalize({ trace: [...trace], outcome, after: await rows(), audit: audits, logs });
  };

  return {
    st,
    agent,
    handle: agent?.handle ?? "",
    deps,
    script,
    run,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    input: (over: Record<string, unknown> = {}) => grantInput(f, st.id, { instance: FORGE, ...over }),
    ref: (grant: { id: string }) => ({ tenantId: f.tenant, grantId: grant.id }),
  };
}

/** The next scripted answer: the queue's head, or its last entry once only one is left. */
function next<T>(q: T[]): T | undefined {
  return q.length > 1 ? q.shift() : q[0];
}

const LogLine = z.object({ level: z.string(), component: z.string(), message: z.string(), context: z.unknown().optional() });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarize(v: unknown): unknown {
  if (v && typeof v === "object" && "id" in v && "state" in v && "stateReason" in v && "generation" in v) {
    return { grant: v.id, state: v.state, reason: v.stateReason, generation: v.generation };
  }
  if (v && typeof v === "object" && "grant" in v) {
    const { grant, ...rest } = v;
    return { ...rest, grant: summarize(grant) };
  }
  return v;
}

function describeError(err: unknown) {
  if (!(err instanceof Error)) return { thrown: String(err) };
  const field = (k: string): unknown => (k in err ? Reflect.get(err, k) : null) ?? null;
  return { name: err.name, code: field("code"), status: field("status"), grantId: field("grantId"), message: err.message };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** A delivered minted grant (the trace of making it is not part of the test). */
async function delivered(r: Rig, over: Record<string, unknown> = {}) {
  const grant = await createForgeApiGrant(r.deps, r.input(over));
  expect(grant.state).toBe("delivered");
  return grant;
}

const verifyOk = (login: string, extra: Record<string, unknown> = {}): Reply => ({
  ok: true,
  data: { ok: true, login, isolation: "separate-user", ...extra },
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("the module's export set and its fixed values", () => {
  expect(Object.keys(sfa).toSorted()).toMatchInlineSnapshot(`
    [
      "CLAIM_CAP",
      "FORGE_DELIVER_TIMEOUT_MS",
      "FORGE_STATUS_TIMEOUT_MS",
      "FORGE_VERIFY_TIMEOUT_MS",
      "ForgeApiGrantError",
      "POOL_RESERVE",
      "REVOKED_NOTHING_SUPPLIED",
      "REVOKED_STATION_GONE",
      "SAME_USER_ACK_REQUIRED",
      "SEALED_BLOB_TTL_MS",
      "SUPPLIED_BLOB_MAX",
      "VERIFY_PENDING",
      "acceptSuppliedSecret",
      "blobIsLive",
      "claimFaults",
      "compensateRevoke",
      "confirmSuppliedRevoked",
      "createForgeApiGrant",
      "deliverFaults",
      "deliverGrant",
      "fetchStationPublicKey",
      "isWriteGrant",
      "markGrantsRevoking",
      "registerAppGrant",
      "revokeGrant",
      "revokeStrayHandles",
      "revokeTolerant",
      "rotateGrant",
      "rotationOf",
      "serviceNameFor",
      "transition",
      "undoExpiredRotation",
      "untrusted",
      "updateGrantPolicy",
      "verifyGrant",
      "withGrantClaim",
    ]
  `);
  expect({
    SEALED_BLOB_TTL_MS: sfa.SEALED_BLOB_TTL_MS,
    POOL_RESERVE: sfa.POOL_RESERVE,
    CLAIM_CAP: sfa.CLAIM_CAP,
    SAME_USER_ACK_REQUIRED: sfa.SAME_USER_ACK_REQUIRED,
    SUPPLIED_BLOB_MAX: sfa.SUPPLIED_BLOB_MAX,
    FORGE_VERIFY_TIMEOUT_MS: sfa.FORGE_VERIFY_TIMEOUT_MS,
    FORGE_STATUS_TIMEOUT_MS: sfa.FORGE_STATUS_TIMEOUT_MS,
    FORGE_DELIVER_TIMEOUT_MS: sfa.FORGE_DELIVER_TIMEOUT_MS,
    VERIFY_PENDING: sfa.VERIFY_PENDING,
    REVOKED_NOTHING_SUPPLIED: sfa.REVOKED_NOTHING_SUPPLIED,
    REVOKED_STATION_GONE: sfa.REVOKED_STATION_GONE,
    claimFaults: sfa.claimFaults,
    serviceName: sfa.serviceNameFor({ id: "fag_0123456789abcdefABCDEF", provider: "forgejo" }),
    untrusted: [sfa.untrusted("a\u0000b\u001fc\u007f\u0085d"), sfa.untrusted(null), sfa.untrusted("x".repeat(205)).length],
    isWriteGrant: [
      sfa.isWriteGrant({ preset: "read", rules: [] }),
      sfa.isWriteGrant({ preset: "read", rules: [], allowGraphql: true }),
      sfa.isWriteGrant({ preset: "read", rules: [{ allow: " get /x" }, { allow: "head /y" }] }),
      sfa.isWriteGrant({ preset: "read", rules: [{ allow: "post /x" }] }),
      sfa.isWriteGrant({ preset: "read", rules: [{ deny: "POST /x" }] }),
      sfa.isWriteGrant({ preset: "issues", rules: [] }),
    ],
  }).toMatchInlineSnapshot(`
    {
      "CLAIM_CAP": 3,
      "FORGE_DELIVER_TIMEOUT_MS": 120000,
      "FORGE_STATUS_TIMEOUT_MS": 120000,
      "FORGE_VERIFY_TIMEOUT_MS": 90000,
      "POOL_RESERVE": 3,
      "REVOKED_NOTHING_SUPPLIED": "revoked; no credential was ever supplied",
      "REVOKED_STATION_GONE": "revoked; node wipe skipped: station-gone (credential inert)",
      "SAME_USER_ACK_REQUIRED": "same-user-acknowledgement-required",
      "SEALED_BLOB_TTL_MS": 86400000,
      "SUPPLIED_BLOB_MAX": 16384,
      "VERIFY_PENDING": "verify-pending",
      "claimFaults": {
        "failUnlock": false,
      },
      "isWriteGrant": [
        false,
        true,
        false,
        true,
        false,
        true,
      ],
      "serviceName": "forge-forgejo-abcdefabcdef",
      "untrusted": [
        "abcd",
        "",
        201,
      ],
    }
  `);
});

test("transition: the state graph's refusals and its one UPDATE", async () => {
  const r = await rig();
  const grant = await delivered(r);
  const ref = { tenantId: f.tenant, id: grant.id };
  const out = await r.run(async () => {
    const results: unknown[] = [];
    for (const [from, to] of [
      [["delivered"], "authorised"],
      [["revoked"], "revoking"],
      [["verified", "delivered"], "provisioned"],
      [["provisioned"], "failed"],
    ] as const) {
      try {
        await transition(db, ref, [...from], to, { now: T0 });
        results.push("moved");
      } catch (err) {
        results.push(describeError(err));
      }
    }
    const moved = await transition(db, ref, ["delivered"], "revoking", {
      now: new Date("2030-02-02T00:00:00.000Z"),
      stateReason: "why",
      sealed: { blob: "b", expiresAt: new Date("2030-02-03T00:00:00.000Z") },
      verifiedAt: new Date("2030-02-02T00:00:00.000Z"),
    });
    results.push(summarize(moved));
    const done = await transition(db, ref, ["revoking"], "revoked", { now: new Date("2030-02-04T00:00:00.000Z"), sealed: null });
    results.push(summarize(done), done.revokedAt?.toISOString());
    return results;
  });
  expect(out).toMatchInlineSnapshot(`
    {
      "after": [
        "revoked | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-02-02T00:00:00.000Z | separate-user | - | - | read:[] | station",
      ],
      "audit": [
        "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
      ],
      "logs": [],
      "outcome": {
        "ok": [
          {
            "code": "bad-transition",
            "grantId": "<grant1>",
            "message": "forge grant: delivered → authorised is not a lifecycle step.",
            "name": "ForgeApiGrantError",
            "status": 500,
          },
          {
            "code": "bad-transition",
            "grantId": "<grant1>",
            "message": "forge grant: revoked → revoking is not a lifecycle step.",
            "name": "ForgeApiGrantError",
            "status": 500,
          },
          {
            "code": "bad-transition",
            "grantId": "<grant1>",
            "message": "forge grant: verified → provisioned is not a lifecycle step.",
            "name": "ForgeApiGrantError",
            "status": 500,
          },
          {
            "code": "state-conflict",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is not in provisioned; it changed underneath this step.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
          {
            "generation": 1,
            "grant": "<grant1>",
            "reason": "why",
            "state": "revoking",
          },
          {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "revoked",
          },
          "2030-02-04T00:00:00.000Z",
        ],
      },
      "trace": [],
    }
  `);
});

test("createForgeApiGrant (minted): the full traffic of a write grant on a separate-user node", async () => {
  const r = await rig();
  const out = await r.run(() =>
    createForgeApiGrant(r.deps, r.input({ preset: "issues", rules: [{ deny: "DELETE /x" }], repositories: ["org/a", "org/b"] })),
  );
  expect(out).toMatchInlineSnapshot(`
    {
      "after": [
        "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[{"deny":"DELETE /x"}] | station",
      ],
      "audit": [
        "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:issues","stationKey":"claude-code:<station>"}",
      ],
      "logs": [
        "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
        "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"separate-user"}",
      ],
      "outcome": {
        "ok": {
          "generation": 1,
          "grant": "<grant1>",
          "reason": null,
          "state": "delivered",
        },
      },
      "trace": [
        [
          "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
        ],
        [
          "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository","write:issue"],"repositories":[{"owner":"org","name":"a"},{"owner":"org","name":"b"}]}",
          "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | issues:[{"deny":"DELETE /x"}] | station",
        ],
        [
          "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
          "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | issues:[{"deny":"DELETE /x"}] | station",
        ],
        [
          "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/a","org/b"],"preset":"issues","rules":[{"deny":"DELETE /x"}],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
          "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[{"deny":"DELETE /x"}] | station",
        ],
      ],
    }
  `);
});

test("createForgeApiGrant: every refusal, and the calls made before it", async () => {
  const r = await rig();
  const bare = await rig({ occupied: false });
  const old = await rig({ capabilities: ["acp"] });
  const cases: [string, Rig, Record<string, unknown>, (Rig["script"]["node"][string])?][] = [
    ["github cannot mint", r, { provider: "github", instance: "https://github.com" }],
    ["another forge", r, { instance: "https://elsewhere.test" }],
    ["unknown station", r, { stationId: "station_nope" }],
    ["no occupant", bare, {}],
    ["supplied without a login", r, { mode: "supplied", expectedLogin: "  " }],
    ["no forge.api capability", old, {}],
    ["bad repository", r, { repositories: ["not-a-repo"] }],
    ["preset none", r, { preset: "none" }],
    ["app login with [bot]", r, { provider: "github", instance: "https://github.com", mode: "app", expectedLogin: "my-app[bot]" }],
    ["write grant, same-user node", r, { preset: "issues" }, [STATUS("same-user")]],
    ["write grant, node with no grants", r, { preset: "issues" }, [STATUS()]],
    ["supplied write grant, no ack", r, { mode: "supplied", expectedLogin: "bot", preset: "issues" }],
    ["node preparing", r, {}, [{ ok: false, error: "station-instance-preparing: installing" }]],
    ["node refuses the station", r, {}, [{ ok: false, error: "station-key-changed: secret detail" }]],
    ["node error", r, {}, [{ ok: false, error: "boom\u0007" }]],
    ["broker throws", r, {}, [new Error("socket closed")]],
    ["unreadable status", r, {}, [{ ok: true, data: { nope: 1 } }]],
    ["no key reported", r, {}, [{ ok: true, data: { grants: [] } }]],
  ];
  const results: unknown[] = [];
  for (const [label, which, over, status] of cases) {
    which.script.node["forge.api.status"] = status ?? [STATUS("separate-user")];
    results.push([label, await which.run(() => createForgeApiGrant(which.deps, which.input(over)))]);
  }
  expect(results).toMatchInlineSnapshot(`
    [
      [
        "github cannot mint",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "mode-not-supported",
              "grantId": null,
              "message": "forge: github does not offer minted grants.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "another forge",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "instance-not-forge",
              "grantId": null,
              "message": "forge: a minted grant's instance must be this hub's configured forge (same https origin).",
              "name": "ForgeApiConfigError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "unknown station",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-not-found",
              "grantId": null,
              "message": "station station_nope not found.",
              "name": "ForgeApiGrantError",
              "status": 404,
            },
          },
          "trace": [],
        },
      ],
      [
        "no occupant",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "no-occupant",
              "grantId": null,
              "message": "station <station> has no occupant to grant forge access to.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
      [
        "supplied without a login",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "expected-login-required",
              "grantId": null,
              "message": "forge: a supplied grant needs the login the operator created (app: the App slug).",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "no forge.api capability",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "capability-missing",
              "grantId": null,
              "message": "station <station>'s node does not support forge.api; update the node.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
      [
        "bad repository",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-repository",
              "grantId": null,
              "message": "forge: repository must be "owner/name", got "not-a-repo".",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "preset none",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "preset-none-needs-no-token",
              "grantId": null,
              "message": "forge: preset "none" grants no scopes, so a minted token cannot be made for it.",
              "name": "ForgeApiConfigError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "app login with [bot]",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-expected-login",
              "grantId": null,
              "message": "forge: declare the App slug without the [bot] suffix.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "write grant, same-user node",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "same-user-acknowledgement-required",
              "grantId": null,
              "message": "station <station>: the broker runs in same-user mode (or the node has not shown otherwise), so a write grant needs the operator's same-user acknowledgement.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "write grant, node with no grants",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "same-user-acknowledgement-required",
              "grantId": null,
              "message": "station <station>: the broker runs in same-user mode (or the node has not shown otherwise), so a write grant needs the operator's same-user acknowledgement.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "supplied write grant, no ack",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "same-user-acknowledgement-required",
              "grantId": null,
              "message": "station <station>: the broker runs in same-user mode (or the node has not shown otherwise), so a write grant needs the operator's same-user acknowledgement.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
      [
        "node preparing",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-preparing",
              "grantId": null,
              "message": "station <station>: the node is preparing its broker; retry shortly.",
              "name": "ForgeApiGrantError",
              "status": 503,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "node refuses the station",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-key-changed",
              "grantId": null,
              "message": "station <station>: the station's key changed on the node; prune its instance there first.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "node error",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-key-unavailable",
              "grantId": null,
              "message": "station <station>: no stk handover key (boom\x07).",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "broker throws",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-key-unavailable",
              "grantId": null,
              "message": "station <station>: no stk handover key (socket closed).",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "unreadable status",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-key-unavailable",
              "grantId": null,
              "message": "station <station>: no stk handover key (unreadable status reply).",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
      [
        "no key reported",
        {
          "after": [],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "station-key-unavailable",
              "grantId": null,
              "message": "station <station>: no stk handover key (the node did not report one).",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
          ],
        },
      ],
    ]
  `);
});

test("createForgeApiGrant: reusing a live grant, refusing a different one, a revoking one", async () => {
  const r = await rig();
  const grant = await delivered(r);
  const same = await r.run(() => createForgeApiGrant(r.deps, r.input()));
  const different = await r.run(() => createForgeApiGrant(r.deps, r.input({ repositories: ["org/other"] })));
  await transition(db, { tenantId: f.tenant, id: grant.id }, ["delivered"], "revoking", { now: T0 });
  const revoking = await r.run(() => createForgeApiGrant(r.deps, r.input()));
  expect({ same, different, revoking }).toMatchInlineSnapshot(`
    {
      "different": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-exists",
            "grantId": "<grant1>",
            "message": "station <station> already has a forgejo grant for https://forge.char.test (<grant1>); revoke it first.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "revoking": {
        "after": [
          "revoking | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-revoking",
            "grantId": "<grant1>",
            "message": "station <station>'s forgejo grant for https://forge.char.test (<grant1>): revocation is in progress; try again once it is revoked.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            "revoking | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "same": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
    }
  `);
});

test("createForgeApiGrant: mint, persist and seal failures", async () => {
  const mint = await rig();
  mint.script.mint = [Error(`HTTP 502 from the forge`)];
  mint.script.revoke = [Error("HTTP 404 not found")];
  const mintFailed = await mint.run(() => createForgeApiGrant(mint.deps, mint.input()));

  const seal = await rig();
  seal.script.seal = [Error("sealer down")];
  const sealFailed = await seal.run(() => createForgeApiGrant(seal.deps, seal.input()));

  const compensate = await rig();
  compensate.script.mint = [Error("timeout")];
  compensate.script.revoke = [Error("HTTP 503 refused")];
  const compensateFailed = await compensate.run(() => createForgeApiGrant(compensate.deps, compensate.input()));
  expect({ mintFailed, sealFailed, compensateFailed }).toMatchInlineSnapshot(`
    {
      "compensateFailed": {
        "after": [
          "failed | g1 | mint failed: timeout | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (mint failed: timeout) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge compensating revoke failed; reconcile will find the token by name {"grantId":"<grant1>","tokenName":"agentpod-<grant1>-g1","error":"HTTP 503 refused"}",
          "warn forge token mint failed {"grantId":"<grant1>","stationId":"<station>"}",
        ],
        "outcome": {
          "error": {
            "code": "mint-failed",
            "grantId": "<grant1>",
            "message": "mint failed: timeout",
            "name": "ForgeApiGrantError",
            "status": 502,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
          ],
          [
            "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"name":"agentpod-<grant1>-g1"}",
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "mintFailed": {
        "after": [
          "failed | g1 | mint failed: HTTP 502 from the forge | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (mint failed: HTTP 502 from the forge) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge token mint failed {"grantId":"<grant1>","stationId":"<station>"}",
        ],
        "outcome": {
          "error": {
            "code": "mint-failed",
            "grantId": "<grant1>",
            "message": "mint failed: HTTP 502 from the forge",
            "name": "ForgeApiGrantError",
            "status": 502,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
          ],
          [
            "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"name":"agentpod-<grant1>-g1"}",
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "sealFailed": {
        "after": [
          "provisioned | g1 | seal failed: sealer down | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (forge grant <grant1>: sealing the token failed.) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge token seal failed {"grantId":"<grant1>","stationId":"<station>"}",
        ],
        "outcome": {
          "error": {
            "code": "seal-failed",
            "grantId": "<grant1>",
            "message": "forge grant <grant1>: sealing the token failed.",
            "name": "ForgeApiGrantError",
            "status": 500,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
          ],
          [
            "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          [
            "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
            "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
    }
  `);
});

test("createForgeApiGrant: every delivery outcome", async () => {
  const replies: [string, Scripted, string?][] = [
    ["offline", { ok: false, error: "node offline" }],
    ["broker throws", new Error("ws gone")],
    ["preparing", { ok: false, error: "station-instance-preparing: wait" }],
    ["coded refusal", { ok: false, error: "station-uid-shared: detail" }],
    ["plain refusal", { ok: false, error: "disk full" }],
    ["unreadable ack", { ok: true, data: { what: 1 } }],
    ["not stored", { ok: true, data: { ok: true, stored: false, isolation: "separate-user" } }],
    ["same-user ack on a write grant", ACK("same-user"), "issues"],
    ["same-user ack on a read grant", ACK("same-user")],
  ];
  const results: unknown[] = [];
  for (const [label, reply, preset] of replies) {
    const r = await rig();
    r.script.node["forge.api.deliver"] = [reply];
    results.push([label, await r.run(() => createForgeApiGrant(r.deps, r.input(preset ? { preset } : {})))]);
  }
  // The same-user refusal when the node cannot wipe either.
  const r = await rig();
  r.script.node["forge.api.deliver"] = [ACK("same-user")];
  r.script.node["forge.api.revoke"] = [{ ok: false, error: "unknown verb forge.api.revoke" }];
  results.push(["same-user, wipe pending", await r.run(() => createForgeApiGrant(r.deps, r.input({ preset: "issues" })))]);
  expect(results).toMatchInlineSnapshot(`
    [
      [
        "offline",
        {
          "after": [
            "provisioned | g1 | delivery failed: node offline; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (delivery failed: node offline; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"provisioned","reason":"delivery failed: node offline; will retry"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "delivery failed: node offline; will retry",
              "state": "provisioned",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "broker throws",
        {
          "after": [
            "provisioned | g1 | delivery not attempted: ws gone | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (delivery not attempted: ws gone) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"provisioned","reason":"delivery not attempted: ws gone"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "delivery not attempted: ws gone",
              "state": "provisioned",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "preparing",
        {
          "after": [
            "provisioned | g1 | delivery deferred: the node is preparing its broker; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (delivery deferred: the node is preparing its broker; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"provisioned","reason":"delivery deferred: the node is preparing its broker; will retry"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "delivery deferred: the node is preparing its broker; will retry",
              "state": "provisioned",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "coded refusal",
        {
          "after": [
            "failed | g1 | node refused delivery: station-uid-shared: stations on the node share an agent uid; map uids per station or acknowledge it on the node | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (node refused delivery: station-uid-shared: stations on the node share an agent uid; map uids per station or acknowledge it on the node) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"failed","reason":"node refused delivery: station-uid-shared: stations on the node share an agent uid; map uids per station or acknowledge it on the node"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "node refused delivery: station-uid-shared: stations on the node share an agent uid; map uids per station or acknowledge it on the node",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "plain refusal",
        {
          "after": [
            "failed | g1 | node refused delivery: disk full | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (node refused delivery: disk full) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"failed","reason":"node refused delivery: disk full"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "node refused delivery: disk full",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unreadable ack",
        {
          "after": [
            "failed | g1 | node acknowledged delivery with an unreadable reply | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (node acknowledged delivery with an unreadable reply) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"failed","reason":"node acknowledged delivery with an unreadable reply"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "node acknowledged delivery with an unreadable reply",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "not stored",
        {
          "after": [
            "failed | g1 | node did not confirm the token was stored (ok=true, stored=false) | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (node did not confirm the token was stored (ok=true, stored=false)) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"failed","reason":"node did not confirm the token was stored (ok=true, stored=false)"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "node did not confirm the token was stored (ok=true, stored=false)",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "same-user ack on a write grant",
        {
          "after": [
            "failed | g1 | same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | same-user | - | - | issues:[] | station",
          ],
          "audit": [
            "forge.api.grant error (same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement) {"key":"<grant1>","kind":"forgejo","action":"minted:issues","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge write grant refused: same-user isolation without acknowledgement {"grantId":"<grant1>","stationId":"<station>"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository","write:issue"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | issues:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | issues:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"issues","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
            [
              "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
          ],
        },
      ],
      [
        "same-user ack on a read grant",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"same-user"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "delivered",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "same-user, wipe pending",
        {
          "after": [
            "failed | g1 | same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement; wipe-pending: node-too-old | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | same-user | - | - | issues:[] | station",
          ],
          "audit": [
            "forge.api.grant error (same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement; wipe-pending: node-too-old) {"key":"<grant1>","kind":"forgejo","action":"minted:issues","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":1}",
            "warn forge write grant refused: same-user isolation without acknowledgement {"grantId":"<grant1>","stationId":"<station>"}",
          ],
          "outcome": {
            "ok": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "same-user-acknowledgement-required: the node reported same-user isolation; a write grant needs the operator's acknowledgement; wipe-pending: node-too-old",
              "state": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g1","scopes":["read:repository","write:issue"],"repositories":[{"owner":"org","name":"repo"}]}",
              "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | issues:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | - | - | - | - | - | issues:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"issues","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
            [
              "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "provisioned | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | issues:[] | station",
            ],
          ],
        },
      ],
    ]
  `);
});

test("deliverGrant: re-send a live blob, re-mint an expired one, the refusals", async () => {
  const r = await rig();
  r.script.node["forge.api.deliver"] = [{ ok: false, error: "node offline" }, ACK()];
  const grant = await createForgeApiGrant(r.deps, r.input());
  expect(grant.state).toBe("provisioned");
  const resend = await r.run(() => deliverGrant(r.deps, r.ref(grant)));
  const already = await r.run(() => deliverGrant(r.deps, r.ref(grant)));

  const e = await rig();
  e.script.node["forge.api.deliver"] = [{ ok: false, error: "timeout" }, ACK()];
  const g2 = await createForgeApiGrant(e.deps, e.input());
  e.advance(sfa.SEALED_BLOB_TTL_MS + 1);
  const remint = await e.run(() => deliverGrant(e.deps, e.ref(g2)));

  const b = await rig();
  b.script.node["forge.api.deliver"] = [{ ok: false, error: "timeout" }];
  const g3 = await createForgeApiGrant(b.deps, b.input());
  b.advance(sfa.SEALED_BLOB_TTL_MS + 1);
  b.script.revoke = [Error("HTTP 500 forge down")];
  const remintBlocked = await b.run(() => deliverGrant(b.deps, b.ref(g3)));

  const s = await rig();
  const supplied = await createForgeApiGrant(s.deps, s.input({ mode: "supplied", expectedLogin: "bot" }));
  const operatorOnly = await s.run(() => deliverGrant(s.deps, s.ref(supplied)));
  const missing = await s.run(() => deliverGrant(s.deps, { tenantId: f.tenant, grantId: "fag_missing" }));
  await revokeGrant(s.deps, s.ref(supplied));
  const revoked = await s.run(() => deliverGrant(s.deps, s.ref(supplied)));
  expect({ resend, already, remint, remintBlocked, operatorOnly, missing, revoked }).toMatchInlineSnapshot(`
    {
      "already": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [],
      },
      "missing": {
        "after": [
          "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-not-found",
            "grantId": "fag_missing",
            "message": "forge grant fag_missing not found.",
            "name": "ForgeApiGrantError",
            "status": 404,
          },
        },
        "trace": [],
      },
      "operatorOnly": {
        "after": [
          "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-not-deliverable",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> (supplied) has no deliverable credential; the operator must supply a new sealed one.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [],
      },
      "remint": {
        "after": [
          "delivered | g2 | - | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | delivered@2030-01-02T00:00:00.001Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (delivery failed: timeout; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "info forge token minted and sealed {"grantId":"<grant1>","stationId":"<station>","generation":2}",
          "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"separate-user"}",
        ],
        "outcome": {
          "ok": {
            "generation": 2,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            "provisioned | g1 | delivery failed: timeout; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "provisioned | g1 | delivery failed: timeout; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          [
            "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
            "provisioned | g2 | re-minting: the sealed blob expired before delivery | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          [
            "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
            "provisioned | g2 | - | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | - | - | - | - | - | read:[] | station",
          ],
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
            "provisioned | g2 | - | {"id":901,"name":"agentpod-<grant1>-g2"} | blob@2030-01-03T00:00:00.001Z | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "remintBlocked": {
        "after": [
          "failed | g1 | re-mint blocked: revoking the undelivered token failed: HTTP 500 forge down | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (delivery failed: timeout; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge grant re-mint blocked {"grantId":"<grant1>","stationId":"<station>"}",
        ],
        "outcome": {
          "error": {
            "code": "revoke-failed",
            "grantId": "<grant1>",
            "message": "re-mint blocked: revoking the undelivered token failed: HTTP 500 forge down",
            "name": "ForgeApiGrantError",
            "status": 502,
          },
        },
        "trace": [
          [
            "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
            "provisioned | g1 | delivery failed: timeout; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "provisioned | g1 | delivery failed: timeout; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "resend": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (delivery failed: node offline; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"separate-user"}",
        ],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
            "provisioned | g1 | delivery failed: node offline; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "revoked": {
        "after": [
          "revoked | g1 | revoked; no credential was ever supplied | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-not-deliverable",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is revoked.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [],
      },
    }
  `);
});

test("supplied and app credentials: create, accept, register", async () => {
  const s = await rig();
  const create = await s.run(() =>
    createForgeApiGrant(s.deps, s.input({ mode: "supplied", expectedLogin: " bot ", preset: "issues", acknowledgeSameUser: true })),
  );
  const [row] = await db.select().from(g).where(eq(g.stationIdSnapshot, s.st.id));
  if (!row) throw new Error("the supplied grant was not created");
  const badBlob = await s.run(() => acceptSuppliedSecret(s.deps, { ...s.ref(row), sealed: "plaintext-token" }));
  const accept = await s.run(() => acceptSuppliedSecret(s.deps, { ...s.ref(row), sealed: SUPPLIED }));
  s.script.node["forge.api.deliver"] = [{ ok: false, error: "node offline" }];
  const reaccept = await s.run(() => acceptSuppliedSecret(s.deps, { ...s.ref(row), sealed: SUPPLIED + "2" }));

  const m = await rig();
  const minted = await delivered(m);
  const mintedRefused = await m.run(() => acceptSuppliedSecret(m.deps, { ...m.ref(minted), sealed: SUPPLIED }));

  const a = await rig();
  const appInput: Parameters<typeof registerAppGrant>[1] = {
    ...a.input(),
    provider: "github",
    instance: "https://github.com",
    mode: "app",
    expectedLogin: "my-app",
    sealed: SUPPLIED,
  };
  const app = await a.run(() => registerAppGrant(a.deps, appInput));
  const notApp = await a.run(() => registerAppGrant(a.deps, { ...a.input(), mode: "supplied", sealed: SUPPLIED }));
  expect({ create, badBlob, accept, reaccept, mintedRefused, app, notApp }).toMatchInlineSnapshot(`
    {
      "accept": {
        "after": [
          "delivered | g1 | - | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | ack:test-user-<run> | issues:[] | station",
        ],
        "audit": [],
        "logs": [
          "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"separate-user"}",
        ],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"supplied","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"issues","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS","expectLogin":"bot"} {"timeoutMs":120000}",
            "provisioned | g1 | - | no-handle | blob@2030-01-02T00:00:00.000Z | - | - | - | - | ack:test-user-<run> | issues:[] | station",
          ],
        ],
      },
      "app": {
        "after": [
          "delivered | g1 | - | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"github","action":"app:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "info forge grant delivered {"grantId":"<grant1>","stationId":"<station>","isolation":"separate-user"}",
        ],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"github","instance":"https://github.com","mode":"app","serviceName":"forge-github-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS","expectLogin":"my-app[bot]"} {"timeoutMs":120000}",
            "provisioned | g1 | - | no-handle | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
      "badBlob": {
        "after": [
          "authorised | g1 | - | no-handle | no-blob | - | - | - | - | ack:test-user-<run> | issues:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "bad-sealed-blob",
            "grantId": "<grant1>",
            "message": "forge: a supplied credential must be a stk-handover-v1: envelope of at most 16384 characters.",
            "name": "ForgeApiGrantError",
            "status": 422,
          },
        },
        "trace": [],
      },
      "create": {
        "after": [
          "authorised | g1 | - | no-handle | no-blob | - | - | - | - | ack:test-user-<run> | issues:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:issues","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": null,
            "state": "authorised",
          },
        },
        "trace": [],
      },
      "mintedRefused": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "error": {
            "code": "mode-not-supported",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is minted; the hub makes its token.",
            "name": "ForgeApiGrantError",
            "status": 422,
          },
        },
        "trace": [],
      },
      "notApp": {
        "after": [
          "delivered | g1 | - | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "mode-not-supported",
            "grantId": null,
            "message": "forge: registerAppGrant is for app grants, not supplied.",
            "name": "ForgeApiGrantError",
            "status": 422,
          },
        },
        "trace": [],
      },
      "reaccept": {
        "after": [
          "delivered | g1 | delivery failed: node offline; will retry | no-handle | blob@2030-01-02T00:00:00.000Z | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | ack:test-user-<run> | issues:[] | station",
        ],
        "audit": [],
        "logs": [
          "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"delivered","reason":"delivery failed: node offline; will retry"}",
        ],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": "delivery failed: node offline; will retry",
            "state": "delivered",
          },
        },
        "trace": [
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"supplied","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"issues","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS2","expectLogin":"bot"} {"timeoutMs":120000}",
            "delivered | g1 | - | no-handle | blob@2030-01-02T00:00:00.000Z | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | ack:test-user-<run> | issues:[] | station",
          ],
        ],
      },
    }
  `);
});

test("verifyGrant: every answer the node can give, in turn, on one grant", async () => {
  const r = await rig();
  const grant = await delivered(r);
  const login = r.handle;
  const answers: [string, Scripted][] = [
    ["ok", verifyOk(login)],
    ["partial coverage", verifyOk(login, { bypass: { clients: [{ client: "git", outcome: "untested" }, { client: "c\u0001url", outcome: "honoured" }], brokered: true, measured: "partial" } })],
    ["not brokered", verifyOk(login, { bypass: { clients: [{ client: "gh", outcome: "bypassed" }], paths: [{ path: "git", wired: false }], brokered: false } })],
    ["not wired", { ok: true, data: { ok: false, reason: "not-wired: nothing", isolation: "same-user", bypass: { clients: [], paths: [{ path: "p1", wired: false }, { path: "p2", wired: true }], wiringBlocked: "a, b", brokered: false } } }],
    ["provider down", { ok: true, data: { ok: false, reason: "unreachable: dns", isolation: "same-user" } }],
    ["unknown code", { ok: true, data: { ok: false, reason: "brand-new: x", isolation: "same-user" } }],
    ["offline", { ok: false, error: "node offline" }],
    ["broker throws", new Error("ws\u0000 gone")],
    ["wrong login", verifyOk("someone-else")],
    ["ok again", verifyOk(login.toUpperCase())],
    ["bypassed", { ok: true, data: { ok: false, reason: "bypassed: curl", isolation: "same-user", bypass: { clients: ["a", "b", "c", "d", "e", "f"].map((client) => ({ client, outcome: "bypassed" })), brokered: false } } }],
    ["definitive", { ok: true, data: { ok: false, reason: "forbidden: no", isolation: "same-user" } }],
    ["wrong-identity code", { ok: true, data: { ok: false, reason: "wrong-identity: is x", isolation: "same-user" } }],
    ["unknown verb", { ok: false, error: "unknown verb forge.api.verify" }],
    ["node error", { ok: false, error: "kaput" }],
    ["unreadable", { ok: true, data: { what: 1 } }],
  ];
  const results: unknown[] = [];
  for (const [label, answer] of answers) {
    r.script.node["forge.api.verify"] = [answer];
    r.advance(1000);
    results.push([label, await r.run(() => verifyGrant(r.deps, r.ref(grant)))]);
  }
  const s = await rig();
  const supplied = await createForgeApiGrant(s.deps, s.input({ mode: "supplied", expectedLogin: "bot" }));
  results.push(["not verifiable", await s.run(() => verifyGrant(s.deps, s.ref(supplied)))]);
  expect(results).toMatchInlineSnapshot(`
    [
      [
        "ok",
        {
          "after": [
            "verified | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:01.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge grant verified {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": null,
                "state": "verified",
              },
              "outcome": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "partial coverage",
        {
          "after": [
            "verified | g1 | coverage: partial (untested: git) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:02.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verified {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "coverage: partial (untested: git)",
                "state": "verified",
              },
              "outcome": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "verified | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:01.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "not brokered",
        {
          "after": [
            "delivered | g1 | coverage-incomplete: bypassed, unwired | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant not verified: traffic not shown to go through the broker {"grantId":"<grant1>","reason":"coverage-incomplete: bypassed, unwired"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "coverage-incomplete: bypassed, unwired",
                "state": "delivered",
              },
              "outcome": "unbrokered",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "verified | g1 | coverage: partial (untested: git) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:02.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "not wired",
        {
          "after": [
            "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verify inconclusive {"grantId":"<grant1>","reason":"not-wired: p1 (blocked by a, b)"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "not-wired: p1 (blocked by a, b)",
                "state": "delivered",
              },
              "outcome": "inconclusive",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | coverage-incomplete: bypassed, unwired | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "provider down",
        {
          "after": [
            "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verify inconclusive {"grantId":"<grant1>","reason":"provider unavailable: unreachable: dns"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "not-wired: p1 (blocked by a, b)",
                "state": "delivered",
              },
              "outcome": "provider-unavailable",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unknown code",
        {
          "after": [
            "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verify inconclusive {"grantId":"<grant1>","reason":"verify inconclusive: brand-new: x"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "not-wired: p1 (blocked by a, b)",
                "state": "delivered",
              },
              "outcome": "inconclusive",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "offline",
        {
          "after": [
            "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verify deferred: node unreachable {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "not-wired: p1 (blocked by a, b)",
                "state": "delivered",
              },
              "outcome": "node-offline",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "broker throws",
        {
          "after": [
            "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verify deferred: node unreachable {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "not-wired: p1 (blocked by a, b)",
                "state": "delivered",
              },
              "outcome": "node-offline",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "wrong login",
        {
          "after": [
            "failed | g1 | wrong-identity: expected <occupant-handle>, the forge answered as someone-else | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"wrong-identity: expected <occupant-handle>, the forge answered as someone-else"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "wrong-identity: expected <occupant-handle>, the forge answered as someone-else",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g1 | not-wired: p1 (blocked by a, b) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "ok again",
        {
          "after": [
            "verified | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verified {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": null,
                "state": "verified",
              },
              "outcome": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | wrong-identity: expected <occupant-handle>, the forge answered as someone-else | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "bypassed",
        {
          "after": [
            "failed | g1 | bypassed: a, b, c, d, e (+1) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"bypassed: a, b, c, d, e (+1)"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "bypassed: a, b, c, d, e (+1)",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "verified | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "definitive",
        {
          "after": [
            "failed | g1 | verify-failed: forbidden: no | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"verify-failed: forbidden: no"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "verify-failed: forbidden: no",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | bypassed: a, b, c, d, e (+1) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "wrong-identity code",
        {
          "after": [
            "failed | g1 | wrong-identity: is x | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"wrong-identity: is x"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "wrong-identity: is x",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | verify-failed: forbidden: no | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unknown verb",
        {
          "after": [
            "failed | g1 | node-too-old: the node does not know forge.api.verify | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"node-too-old: the node does not know forge.api.verify"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "node-too-old: the node does not know forge.api.verify",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | wrong-identity: is x | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "node error",
        {
          "after": [
            "failed | g1 | verify-failed: kaput | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"verify-failed: kaput"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "verify-failed: kaput",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | node-too-old: the node does not know forge.api.verify | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unreadable",
        {
          "after": [
            "failed | g1 | verify-failed: unreadable verify reply | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant failed verification {"grantId":"<grant1>","reason":"verify-failed: unreadable verify reply"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "verify-failed: unreadable verify reply",
                "state": "failed",
              },
              "outcome": "failed",
            },
          },
          "trace": [
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "failed | g1 | verify-failed: kaput | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | verified@2030-01-01T00:00:10.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "not verifiable",
        {
          "after": [
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [],
          "outcome": {
            "error": {
              "code": "grant-not-verifiable",
              "grantId": "<grant1>",
              "message": "forge grant <grant1> is authorised; nothing to verify.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
    ]
  `);
});

test("verifyGrant: a live unacknowledged blob is re-sent first", async () => {
  const r = await rig();
  r.script.node["forge.api.deliver"] = [{ ok: false, error: "node offline" }, { ok: false, error: "node offline" }, ACK()];
  r.script.node["forge.api.verify"] = [{ ok: true, data: { ok: true, login: "", isolation: "separate-user" } }];
  const grant = await createForgeApiGrant(r.deps, r.input());
  await transition(db, { tenantId: f.tenant, id: grant.id }, ["provisioned"], "failed", { now: T0 });
  const stillOffline = await r.run(() => verifyGrant(r.deps, r.ref(grant)));
  r.script.node["forge.api.verify"] = [verifyOk(r.handle)];
  const resent = await r.run(() => verifyGrant(r.deps, r.ref(grant)));
  expect({ stillOffline, resent }).toMatchInlineSnapshot(`
    {
      "resent": {
        "after": [
          "provisioned | g1 | delivery failed: node offline; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-not-verifiable",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is provisioned; nothing to verify.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [],
      },
      "stillOffline": {
        "after": [
          "provisioned | g1 | delivery failed: node offline; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant error (delivery failed: node offline; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge grant not delivered {"grantId":"<grant1>","stationId":"<station>","state":"provisioned","reason":"delivery failed: node offline; will retry"}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "delivery failed: node offline; will retry",
              "state": "provisioned",
            },
            "outcome": "node-offline",
          },
        },
        "trace": [
          [
            "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED1","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
            "failed | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
        ],
      },
    }
  `);
});

test("rotateGrant: verified, and each way a rotation stops", async () => {
  const results: unknown[] = [];
  const scenario = async (label: string, setup: (r: Rig) => void) => {
    const r = await rig();
    const grant = await delivered(r);
    r.script.node["forge.api.verify"] = [verifyOk(r.handle)];
    r.advance(60_000);
    setup(r);
    results.push([label, await r.run(() => rotateGrant(r.deps, r.ref(grant)))]);
    return { r, grant };
  };
  await scenario("verified", () => undefined);
  await scenario("mint fails", (r) => {
    r.script.mint = [Error("HTTP 500 mint")];
  });
  await scenario("check fails", (r) => {
    r.script.check = [Error("HTTP 401 bad token")];
  });
  await scenario("wrong owner", (r) => {
    r.script.check = ["intruder"];
  });
  await scenario("seal fails", (r) => {
    r.script.seal = [Error("sealer")];
  });
  await scenario("deliver refused, revoke fails (orphan)", (r) => {
    r.script.node["forge.api.deliver"] = [{ ok: false, error: "no thanks" }];
    r.script.revoke = [Error("HTTP 503 nope")];
  });
  const { r: pending, grant } = await scenario("deliver transient", (r) => {
    r.script.node["forge.api.deliver"] = [{ ok: false, error: "timeout" }];
  });
  await scenario("verify wrong identity after ack", (r) => {
    r.script.node["forge.api.verify"] = [verifyOk("intruder")];
  });
  await scenario("verify forbidden after ack, previous revoke fails", (r) => {
    r.script.node["forge.api.verify"] = [{ ok: true, data: { ok: false, reason: "forbidden: x", isolation: "same-user" } }];
    r.script.revoke = [Error("HTTP 500 a")];
  });
  await scenario("verify offline after ack", (r) => {
    r.script.node["forge.api.verify"] = [{ ok: false, error: "node offline" }];
  });
  await scenario("unbrokered after ack, previous revoke fails", (r) => {
    r.script.node["forge.api.verify"] = [verifyOk(r.handle, { bypass: { clients: [], brokered: false } })];
    r.script.revoke = [Error("HTTP 500 b")];
  });
  await scenario("ok after ack, previous revoke fails", (r) => {
    r.script.revoke = [Error("HTTP 500 c")];
  });
  results.push(["unfinished rotation", await pending.run(() => rotateGrant(pending.deps, pending.ref(grant)))]);
  // The pending rotation, finished by verify, then left to expire on another grant.
  pending.script.node["forge.api.deliver"] = [ACK()];
  results.push(["verify finishes it", await pending.run(() => verifyGrant(pending.deps, pending.ref(grant)))]);
  const s = await rig();
  const supplied = await createForgeApiGrant(s.deps, s.input({ mode: "supplied", expectedLogin: "bot" }));
  results.push(["supplied", await s.run(() => rotateGrant(s.deps, s.ref(supplied)))]);
  const p = await rig();
  p.script.node["forge.api.deliver"] = [{ ok: false, error: "timeout" }];
  const prov = await createForgeApiGrant(p.deps, p.input());
  results.push(["not delivered", await p.run(() => rotateGrant(p.deps, p.ref(prov)))]);
  expect(results).toMatchInlineSnapshot(`
    [
      [
        "verified",
        {
          "after": [
            "verified | g2 | - | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge grant verified {"grantId":"<grant1>"}",
            "info forge grant rotated {"grantId":"<grant1>","stationId":"<station>","generation":2}",
          ],
          "outcome": {
            "ok": {
              "generation": 2,
              "grant": "<grant1>",
              "reason": null,
              "state": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "verified | g2 | verified; revoking agentpod-<grant1>-g1 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "mint fails",
        {
          "after": [
            "delivered | g1 | rotation-failed: mint failed: HTTP 500 mint | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: mint failed: HTTP 500 mint"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: mint failed: HTTP 500 mint",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "check fails",
        {
          "after": [
            "delivered | g1 | rotation-failed: the new token did not check out: HTTP 401 bad token | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: the new token did not check out: HTTP 401 bad token"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: the new token did not check out: HTTP 401 bad token",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "wrong owner",
        {
          "after": [
            "delivered | g1 | rotation-failed: the new token belongs to intruder, not <occupant-handle> | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: the new token belongs to intruder, not <occupant-handle>"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: the new token belongs to intruder, not <occupant-handle>",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "seal fails",
        {
          "after": [
            "delivered | g1 | rotation-failed: seal failed: sealer | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: seal failed: sealer"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: seal failed: sealer",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "deliver refused, revoke fails (orphan)",
        {
          "after": [
            "delivered | g1 | rotation-failed: node refused delivery: no thanks | {"id":900,"name":"agentpod-<grant1>-g1","orphan":{"id":901,"name":"agentpod-<grant1>-g2"}} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge compensating revoke failed; reconcile will find the token by name {"grantId":"<grant1>","tokenName":"agentpod-<grant1>-g2","error":"HTTP 503 nope"}",
            "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: node refused delivery: no thanks"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: node refused delivery: no thanks",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "deliver transient",
        {
          "after": [
            "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation delivery unconfirmed; nothing revoked {"grantId":"<grant1>","stationId":"<station>"}",
          ],
          "outcome": {
            "ok": {
              "generation": 2,
              "grant": "<grant1>",
              "reason": "rotation-pending: delivery failed: timeout; will retry",
              "state": "delivered",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "verify wrong identity after ack",
        {
          "after": [
            "failed | g2 | rotation-failed: wrong-identity: expected <occupant-handle>, the forge answered as intruder | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant rotation failed after delivery {"grantId":"<grant1>","reason":"rotation-failed: wrong-identity: expected <occupant-handle>, the forge answered as intruder"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: wrong-identity: expected <occupant-handle>, the forge answered as intruder",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "verify forbidden after ack, previous revoke fails",
        {
          "after": [
            "failed | g2 | rotation-failed: verify-failed: forbidden: x | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"revoke"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge compensating revoke failed; reconcile will find the token by name {"grantId":"<grant1>","tokenName":"agentpod-<grant1>-g1","error":"HTTP 500 a"}",
            "warn forge grant rotation failed after delivery {"grantId":"<grant1>","reason":"rotation-failed: verify-failed: forbidden: x"}",
          ],
          "outcome": {
            "error": {
              "code": "rotation-failed",
              "grantId": "<grant1>",
              "message": "forge grant <grant1>: rotation-failed: verify-failed: forbidden: x",
              "name": "ForgeApiGrantError",
              "status": 502,
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "verify offline after ack",
        {
          "after": [
            "delivered | g2 | rotation-pending: node-offline | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "info forge grant verify deferred: node unreachable {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "generation": 2,
              "grant": "<grant1>",
              "reason": "rotation-pending: node-offline",
              "state": "delivered",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unbrokered after ack, previous revoke fails",
        {
          "after": [
            "delivered | g2 | previous-revoke-pending: HTTP 500 b | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"revoke"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant not verified: traffic not shown to go through the broker {"grantId":"<grant1>","reason":"coverage-incomplete: probe-failed"}",
          ],
          "outcome": {
            "ok": {
              "generation": 2,
              "grant": "<grant1>",
              "reason": "previous-revoke-pending: HTTP 500 b",
              "state": "delivered",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "delivered | g2 | coverage-incomplete: probe-failed | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "ok after ack, previous revoke fails",
        {
          "after": [
            "verified | g2 | previous-revoke-pending: HTTP 500 c | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"revoke"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant verified but the previous token is not revoked yet {"grantId":"<grant1>"}",
            "info forge grant verified {"grantId":"<grant1>"}",
            "info forge grant rotated {"grantId":"<grant1>","stationId":"<station>","generation":2}",
          ],
          "outcome": {
            "ok": {
              "generation": 2,
              "grant": "<grant1>",
              "reason": "previous-revoke-pending: HTTP 500 c",
              "state": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.status {"stationId":"<station>"} {"timeoutMs":120000}",
              "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.mint <occupant-handle> {"name":"agentpod-<grant1>-g2","scopes":["read:repository"],"repositories":[{"owner":"org","name":"repo"}]}",
              "delivered | g2 | rotation-pending: minting generation 2 | {"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.checkToken <occupant-handle> <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "seal stk-handover-v1:KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK ["token"] <the minted secret>",
              "delivered | g2 | rotation-pending: minting generation 2 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivering | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "verified | g2 | verified; revoking agentpod-<grant1>-g1 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unfinished rotation",
        {
          "after": [
            "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "grant-not-rotatable",
              "grantId": "<grant1>",
              "message": "forge grant <grant1> has an unfinished rotation or a token to revoke; finish that first.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
      [
        "verify finishes it",
        {
          "after": [
            "verified | g2 | - | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "info forge grant verified {"grantId":"<grant1>"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 2,
                "grant": "<grant1>",
                "reason": null,
                "state": "verified",
              },
              "outcome": "verified",
            },
          },
          "trace": [
            [
              "node <node> forge.api.deliver {"stationId":"<station>","stationKey":"claude-code:<station>","grantId":"<grant1>","provider":"forgejo","instance":"https://forge.char.test","mode":"minted","serviceName":"forge-forgejo-<grant1-tail>","repositories":["org/repo"],"preset":"read","rules":[],"allowGraphql":false,"sealed":"stk-handover-v1:SEALED2","expectLogin":"<occupant-handle>"} {"timeoutMs":120000}",
              "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:01:00.000Z | - | - | separate-user | - | - | read:[] | station",
            ],
            [
              "node <node> forge.api.verify {"stationId":"<station>","grantId":"<grant1>","expectLogin":"<occupant-handle>"} {"timeoutMs":90000}",
              "delivered | g2 | rotation-pending: awaiting verification | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | - | separate-user | - | - | read:[] | station",
            ],
            [
              "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
              "verified | g2 | verified; revoking agentpod-<grant1>-g1 | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | no-blob | delivered@2030-01-01T00:01:00.000Z | verified@2030-01-01T00:01:00.000Z | separate-user | - | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "supplied",
        {
          "after": [
            "authorised | g1 | - | no-handle | no-blob | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [],
          "outcome": {
            "error": {
              "code": "mode-not-supported",
              "grantId": "<grant1>",
              "message": "forge grant <grant1> is supplied: rotate it by supplying a new sealed credential.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "not delivered",
        {
          "after": [
            "provisioned | g1 | delivery failed: timeout; will retry | {"id":900,"name":"agentpod-<grant1>-g1"} | blob@2030-01-02T00:00:00.000Z | - | - | - | - | - | read:[] | station",
          ],
          "audit": [
            "forge.api.grant error (delivery failed: timeout; will retry) {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [],
          "outcome": {
            "error": {
              "code": "grant-not-rotatable",
              "grantId": "<grant1>",
              "message": "forge grant <grant1> is provisioned; only a delivered grant rotates.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
    ]
  `);
});

test("undoExpiredRotation and verify on an interrupted rotation", async () => {
  const r = await rig();
  const grant = await delivered(r);
  r.script.node["forge.api.deliver"] = [{ ok: false, error: "timeout" }];
  await rotateGrant(r.deps, r.ref(grant));
  const live = await r.run(() => undoExpiredRotation(r.deps, r.ref(grant)));
  r.advance(sfa.SEALED_BLOB_TTL_MS + 1);
  const verifyExpired = await r.run(() => verifyGrant(r.deps, r.ref(grant)));
  const undo = await r.run(() => undoExpiredRotation(r.deps, r.ref(grant)));

  const i = await rig();
  const g2 = await delivered(i);
  i.script.seal = [null, Error("sealer")];
  await rotateGrant(i.deps, i.ref(g2)).catch(() => undefined);
  // Make it look interrupted between mint and seal: previous kept, no blob, delivered_at cleared.
  const [row] = await db.select().from(g).where(eq(g.id, g2.id));
  if (!row?.tokenHandle) throw new Error("the rotated grant has no handle");
  await db
    .update(g)
    .set({ tokenHandle: { id: 77, name: "agentpod-new", previous: { ...row.tokenHandle, disposition: "live-until-verified", generation: 1, deliveredAt: null } }, deliveredAt: null })
    .where(eq(g.id, g2.id));
  const interrupted = await i.run(() => verifyGrant(i.deps, i.ref(g2)));
  expect({ live, verifyExpired, undo, interrupted }).toMatchInlineSnapshot(`
    {
      "interrupted": {
        "after": [
          "failed | g1 | rotation-failed: interrupted before the new token was sealed | {"id":901,"name":"agentpod-<grant1>-g2"} | no-blob | - | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: interrupted before the new token was sealed"}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "rotation-failed: interrupted before the new token was sealed",
              "state": "failed",
            },
            "outcome": "rotation-failed",
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"id":77,"name":"agentpod-new"}",
            "failed | g2 | rotation-failed: node-too-old: the node does not know forge.api.verify | {"id":77,"name":"agentpod-new","previous":{"id":901,"name":"agentpod-<grant1>-g2","generation":1,"deliveredAt":null,"disposition":"live-until-verified"}} | no-blob | - | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "live": {
        "after": [
          "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:00:00.000Z | - | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "generation": 2,
            "grant": "<grant1>",
            "reason": "rotation-pending: delivery failed: timeout; will retry",
            "state": "delivered",
          },
        },
        "trace": [],
      },
      "undo": {
        "after": [
          "delivered | g1 | rotation-failed: the new token's sealed copy expired unacknowledged; verify-pending | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [
          "warn forge grant rotation undone before delivery; the previous token stays live {"grantId":"<grant1>","reason":"rotation-failed: the new token's sealed copy expired unacknowledged"}",
        ],
        "outcome": {
          "ok": {
            "generation": 1,
            "grant": "<grant1>",
            "reason": "rotation-failed: the new token's sealed copy expired unacknowledged; verify-pending",
            "state": "delivered",
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"id":901,"name":"agentpod-<grant1>-g2"}",
            "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:00:00.000Z | - | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "verifyExpired": {
        "after": [
          "delivered | g2 | rotation-pending: delivery failed: timeout; will retry | {"id":901,"name":"agentpod-<grant1>-g2","previous":{"id":900,"name":"agentpod-<grant1>-g1","generation":1,"deliveredAt":"2030-01-01T00:00:00.000Z","disposition":"live-until-verified"}} | blob@2030-01-02T00:00:00.000Z | - | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-not-verifiable",
            "grantId": "<grant1>",
            "message": "forge grant <grant1>: its current credential was never acknowledged and the sealed copy expired.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [],
      },
    }
  `);
});

test("revokeGrant and confirmSuppliedRevoked: each side, retried, and the station gone", async () => {
  const r = await rig();
  const grant = await delivered(r);
  r.script.node["forge.api.revoke"] = [{ ok: false, error: "node offline" }, { ok: true, data: { removed: false } }];
  r.script.revoke = [Error("HTTP 500 forge"), null];
  const first = await r.run(() => revokeGrant(r.deps, r.ref(grant)));
  const retry = await r.run(() => revokeGrant(r.deps, r.ref(grant)));
  const again = await r.run(() => revokeGrant(r.deps, r.ref(grant)));

  const s = await rig();
  const supplied = await createForgeApiGrant(s.deps, s.input({ mode: "supplied", expectedLogin: "bot" }));
  await acceptSuppliedSecret(s.deps, { ...s.ref(supplied), sealed: SUPPLIED });
  const confirmEarly = await s.run(() => confirmSuppliedRevoked(s.deps, s.ref(supplied)));
  s.script.node["forge.api.revoke"] = [{ ok: true, data: { unexpected: true } }, { ok: true, data: { removed: true } }];
  const operator = await s.run(() => revokeGrant(s.deps, s.ref(supplied)));
  const confirm = await s.run(() => confirmSuppliedRevoked(s.deps, s.ref(supplied)));
  const confirmMinted = await r.run(() => confirmSuppliedRevoked(r.deps, r.ref(grant)));

  const n = await rig();
  const never = await createForgeApiGrant(n.deps, n.input({ mode: "supplied", expectedLogin: "bot" }));
  const nothing = await n.run(() => revokeGrant(n.deps, n.ref(never)));

  const gone = await rig();
  const g4 = await delivered(gone);
  await rawSql`UPDATE station_forge_api_grants SET station_id = NULL WHERE id = ${g4.id}`;
  const stationGone = await gone.run(() => revokeGrant(gone.deps, gone.ref(g4)));

  const old = await rig();
  const g5 = await delivered(old);
  await rawSql`UPDATE stations SET capabilities = '["acp"]'::jsonb WHERE id = ${old.st.id}`;
  const nodeTooOld = await old.run(() => revokeGrant(old.deps, old.ref(g5)));
  expect({ first, retry, again, confirmEarly, operator, confirm, confirmMinted, nothing, stationGone, nodeTooOld }).toMatchInlineSnapshot(`
    {
      "again": {
        "after": [
          "revoked | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "revoked",
            },
            "outcome": "revoked",
          },
        },
        "trace": [],
      },
      "confirm": {
        "after": [
          "revoked | g1 | - | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [
          "info forge grant revoked {"grantId":"<grant1>","stationId":"<station>","wipeSkipped":false}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "revoked",
            },
            "outcome": "revoked",
          },
        },
        "trace": [
          [
            "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
            "revoking | g1 | revocation-pending-operator: the operator must revoke this token at the provider; wipe-pending: unreadable revoke reply | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "confirmEarly": {
        "after": [
          "delivered | g1 | - | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "error": {
            "code": "bad-transition",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is delivered; revoke it first.",
            "name": "ForgeApiGrantError",
            "status": 500,
          },
        },
        "trace": [],
      },
      "confirmMinted": {
        "after": [
          "revoked | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "mode-not-supported",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is minted; only supplied grants need an operator confirmation.",
            "name": "ForgeApiGrantError",
            "status": 422,
          },
        },
        "trace": [],
      },
      "first": {
        "after": [
          "revoking | g1 | provider-pending: HTTP 500 forge; wipe-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "warn forge grant revoke at the provider failed; will retry {"grantId":"<grant1>","stationId":"<station>"}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "provider-pending: HTTP 500 forge; wipe-pending: node offline",
              "state": "revoking",
            },
            "outcome": "pending",
          },
        },
        "trace": [
          [
            "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
            "revoking | g1 | provider-pending; wipe-pending | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "revoking | g1 | provider-pending; wipe-pending | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "nodeTooOld": {
        "after": [
          "revoking | g1 | wipe-pending: node-lacks-forge.api | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "wipe-pending: node-lacks-forge.api",
              "state": "revoking",
            },
            "outcome": "wipe-pending",
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "revoking | g1 | provider-pending; wipe-pending | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "nothing": {
        "after": [
          "revoked | g1 | revoked; no credential was ever supplied | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant1>","kind":"forgejo","action":"supplied:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "revoked; no credential was ever supplied",
              "state": "revoked",
            },
            "outcome": "revoked",
          },
        },
        "trace": [],
      },
      "operator": {
        "after": [
          "revoking | g1 | revocation-pending-operator: the operator must revoke this token at the provider; wipe-pending: unreadable revoke reply | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "revocation-pending-operator: the operator must revoke this token at the provider; wipe-pending: unreadable revoke reply",
              "state": "revoking",
            },
            "outcome": "pending-operator",
          },
        },
        "trace": [
          [
            "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
            "revoking | g1 | revocation-pending-operator; wipe-pending | no-handle | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "retry": {
        "after": [
          "revoked | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [
          "info forge grant revoked {"grantId":"<grant1>","stationId":"<station>","wipeSkipped":false}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "revoked",
            },
            "outcome": "revoked",
          },
        },
        "trace": [
          [
            "node <node> forge.api.revoke {"stationId":"<station>","grantId":"<grant1>"} null",
            "revoking | g1 | provider-pending: HTTP 500 forge; wipe-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "revoking | g1 | provider-pending: HTTP 500 forge; wipe-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "stationGone": {
        "after": [
          "revoked | g1 | revoked; node wipe skipped: station-gone (credential inert) | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station-gone",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [
          "info forge grant revoked {"grantId":"<grant1>","stationId":"<station>","wipeSkipped":true}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": "revoked; node wipe skipped: station-gone (credential inert)",
              "state": "revoked",
            },
            "outcome": "revoked",
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"id":900,"name":"agentpod-<grant1>-g1"}",
            "revoking | g1 | provider-pending; wipe-pending | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station-gone",
          ],
        ],
      },
    }
  `);
});

test("updateGrantPolicy: applied, pending, stored, and its refusals", async () => {
  const r = await rig();
  const grant = await delivered(r);
  const base: Parameters<typeof updateGrantPolicy>[1] = { ...r.ref(grant), preset: "read", rules: [], allowGraphql: false };
  const policy = (over: Record<string, unknown> = {}) => Object.assign({ ...base }, over);
  const results: unknown[] = [];
  const step = async (label: string, over: Record<string, unknown>, reply?: Scripted) => {
    if (reply) r.script.node["forge.api.policy"] = [reply];
    r.advance(1000);
    results.push([label, await r.run(() => updateGrantPolicy(r.deps, policy(over)))]);
  };
  await step("applied", { rules: [{ allow: "GET /repos/x" }] }, { ok: true, data: { ok: true } });
  await step("node offline", {}, new Error("node offline"));
  await step("node error", {}, { ok: false, error: "nope\u0001" });
  await step("rejected", {}, { ok: true, data: { ok: false, error: "bad rule" } });
  await step("unreadable", {}, { ok: true, data: { what: 1 } });
  await step("applied again", {}, { ok: true, data: { ok: true } });
  await step("write needs ack (separate-user node: none)", { preset: "issues" });
  await step("unknown preset", { preset: "everything" });
  await step("graphql not boolean", { allowGraphql: "yes" });
  await step("rules not a list", { rules: "x" });
  await step("rule fields", { rules: [{ allow: "GET /x", extra: 1 }] });
  await step("two targets", { rules: [{ allow: "GET /x", deny: "GET /y" }] });
  await step("bad target", { rules: [{ allow: "FETCH /x" }] });
  await transition(db, { tenantId: f.tenant, id: grant.id }, ["delivered", "verified"], "failed", { now: T0, stateReason: "rotation-failed: x" });
  await step("stored (not on the node)", { preset: "issues", acknowledgeSameUser: true, actor: "op" });

  const s = await rig();
  s.script.node["forge.api.deliver"] = [ACK("same-user")];
  const sg = await createForgeApiGrant(s.deps, s.input());
  s.script.node["forge.api.policy"] = [{ ok: false, error: "node offline" }];
  const ackNow = await s.run(() =>
    updateGrantPolicy(s.deps, { ...s.ref(sg), preset: "issues", rules: [], allowGraphql: false, acknowledgeSameUser: true, actor: "op" }),
  );
  const refused = await s.run(() => updateGrantPolicy(s.deps, { ...s.ref(sg), preset: "read", rules: [], allowGraphql: true }));
  results.push(["ack recorded while pending", ackNow], ["same-user ack kept", refused]);
  await revokeGrant(s.deps, s.ref(sg));
  results.push(["revoked", await s.run(() => updateGrantPolicy(s.deps, { ...s.ref(sg), preset: "read", rules: [], allowGraphql: false }))]);
  expect(results).toMatchInlineSnapshot(`
    [
      [
        "applied",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[{"allow":"GET /repos/x"}] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": null,
                "state": "delivered",
              },
              "outcome": "applied",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[{"allow":"GET /repos/x"}],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[{"allow":"GET /repos/x"}] | station",
            ],
          ],
        },
      ],
      [
        "node offline",
        {
          "after": [
            "delivered | g1 | policy-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"node offline"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: node offline",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "node error",
        {
          "after": [
            "delivered | g1 | policy-pending: nope | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"nope"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: nope",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "rejected",
        {
          "after": [
            "delivered | g1 | policy-pending: node rejected the policy: bad rule | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"node rejected the policy: bad rule"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: node rejected the policy: bad rule",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "unreadable",
        {
          "after": [
            "delivered | g1 | policy-pending: unreadable policy reply | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"unreadable policy reply"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: unreadable policy reply",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "applied again",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": null,
                "state": "delivered",
              },
              "outcome": "applied",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | read:[] | station",
            ],
          ],
        },
      ],
      [
        "write needs ack (separate-user node: none)",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": null,
                "state": "delivered",
              },
              "outcome": "applied",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"issues","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | policy-pending | - | issues:[] | station",
            ],
          ],
        },
      ],
      [
        "unknown preset",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: unknown preset.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "graphql not boolean",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: allowGraphql must be a boolean.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "rules not a list",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: rules must be a list.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "rule fields",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: rule 0 has unknown fields or wrong types.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "two targets",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: rule 0 needs exactly one of allow or deny.",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "bad target",
        {
          "after": [
            "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "bad-policy",
              "grantId": "<grant1>",
              "message": "forge policy: rule 0 must be "METHOD /path".",
              "name": "ForgeApiGrantError",
              "status": 422,
            },
          },
          "trace": [],
        },
      ],
      [
        "stored (not on the node)",
        {
          "after": [
            "failed | g1 | rotation-failed: x | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | ack:op | issues:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "rotation-failed: x",
                "state": "failed",
              },
              "outcome": "stored",
            },
          },
          "trace": [],
        },
      ],
      [
        "ack recorded while pending",
        {
          "after": [
            "delivered | g1 | policy-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | policy-pending | ack:op | issues:[] | station",
          ],
          "audit": [
            "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          ],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"node offline"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: node offline",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"issues","rules":[],"allowGraphql":false} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | policy-pending | ack:op | issues:[] | station",
            ],
          ],
        },
      ],
      [
        "same-user ack kept",
        {
          "after": [
            "delivered | g1 | policy-pending: node offline | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | policy-pending | ack:op | read+gql:[] | station",
          ],
          "audit": [],
          "logs": [
            "warn forge grant policy not applied on the node {"grantId":"<grant1>","stationId":"<station>","reason":"node offline"}",
          ],
          "outcome": {
            "ok": {
              "grant": {
                "generation": 1,
                "grant": "<grant1>",
                "reason": "policy-pending: node offline",
                "state": "delivered",
              },
              "outcome": "policy-pending",
            },
          },
          "trace": [
            [
              "node <node> forge.api.policy {"stationId":"<station>","grantId":"<grant1>","preset":"read","rules":[],"allowGraphql":true} null",
              "delivered | g1 | policy-pending: sending to the node | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | policy-pending | ack:op | read+gql:[] | station",
            ],
          ],
        },
      ],
      [
        "revoked",
        {
          "after": [
            "revoked | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | same-user | policy-pending | ack:op | read+gql:[] | station",
          ],
          "audit": [],
          "logs": [],
          "outcome": {
            "error": {
              "code": "grant-not-deliverable",
              "grantId": "<grant1>",
              "message": "forge grant <grant1> is revoked.",
              "name": "ForgeApiGrantError",
              "status": 409,
            },
          },
          "trace": [],
        },
      ],
    ]
  `);
});

test("markGrantsRevoking, revokeStrayHandles and withGrantClaim", async () => {
  const r = await rig();
  const grant = await delivered(r);
  const s = await createForgeApiGrant(r.deps, r.input({ mode: "supplied", provider: "github", instance: "https://github.com", expectedLogin: "bot" }));
  const mark = await r.run(() =>
    db
      .transaction((tx) => markGrantsRevoking(tx, { tenantId: f.tenant, stationId: r.st.id, cause: "reassigned", actor: "op", now: T0 }))
      .then((ids) => ids.map((id) => (id === grant.id ? "the minted grant" : id === s.id ? "the supplied grant" : id)).toSorted()),
  );
  const none = await r.run(() => db.transaction((tx) => markGrantsRevoking(tx, { tenantId: f.tenant, stationId: r.st.id, cause: "station-deleted" })));

  const h = await rig();
  const hg = await delivered(h);
  const noStray = await h.run(() => revokeStrayHandles(h.deps, h.ref(hg)));
  await db
    .update(g)
    .set({
      tokenHandle: { id: 1, name: "cur", previous: { id: 2, name: "prev", disposition: "revoke" }, orphan: { name: "orph" } },
      stateReason: "previous-revoke-pending: earlier",
    })
    .where(eq(g.id, hg.id));
  h.script.revoke = [null, Error("HTTP 500 orphan")];
  const partly = await h.run(() => revokeStrayHandles(h.deps, h.ref(hg)));
  h.script.revoke = [null];
  const cleared = await h.run(() => revokeStrayHandles(h.deps, h.ref(hg)));

  const busy = await h.run(() =>
    sfa.withGrantClaim(f.tenant, hg.id, () => sfa.withGrantClaim(f.tenant, hg.id, async () => "inner")),
  );
  expect({ mark, none, noStray, partly, cleared, busy }).toMatchInlineSnapshot(`
    {
      "busy": {
        "after": [
          "delivered | g1 | - | {"id":1,"name":"cur"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "grant-busy",
            "grantId": "<grant1>",
            "message": "forge grant <grant1> is being worked on by another request; try again.",
            "name": "ForgeApiGrantError",
            "status": 409,
          },
        },
        "trace": [],
      },
      "cleared": {
        "after": [
          "delivered | g1 | - | {"id":1,"name":"cur"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [
          "info forge grant superseded tokens revoked {"grantId":"<grant1>","count":1}",
        ],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "delivered",
            },
            "revoked": [
              "orph",
            ],
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"name":"orph"}",
            "delivered | g1 | previous-revoke-pending: HTTP 500 orphan | {"id":1,"name":"cur","orphan":{"name":"orph"}} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
      "mark": {
        "after": [
          "revoking | g1 | provider-pending; wipe-pending; cause: reassigned | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          "revoking | g1 | nothing-supplied; cause: reassigned | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok (awaiting the operator's sealed credential) {"key":"<grant2>","kind":"github","action":"supplied:read","stationKey":"claude-code:<station>"}",
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
          "forge.api.revoking ok {"mode":"minted","actor":"op","action":"revoking:reassigned","grantId":"<grant1>","provider":"forgejo","generation":1}",
          "forge.api.revoking ok {"mode":"supplied","actor":"op","action":"revoking:reassigned","grantId":"<grant2>","provider":"github","generation":1}",
        ],
        "logs": [
          "info forge grants marked revoking {"stationId":"<station>","cause":"reassigned","grants":2}",
        ],
        "outcome": {
          "ok": [
            "the minted grant",
            "the supplied grant",
          ],
        },
        "trace": [],
      },
      "noStray": {
        "after": [
          "delivered | g1 | - | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [
          "forge.api.grant ok {"key":"<grant1>","kind":"forgejo","action":"minted:read","stationKey":"claude-code:<station>"}",
        ],
        "logs": [],
        "outcome": {
          "ok": {
            "grant": {
              "generation": 1,
              "grant": "<grant1>",
              "reason": null,
              "state": "delivered",
            },
            "revoked": [],
          },
        },
        "trace": [],
      },
      "none": {
        "after": [
          "revoking | g1 | provider-pending; wipe-pending; cause: reassigned | {"id":900,"name":"agentpod-<grant1>-g1"} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          "revoking | g1 | nothing-supplied; cause: reassigned | no-handle | no-blob | - | - | - | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "ok": [],
        },
        "trace": [],
      },
      "partly": {
        "after": [
          "delivered | g1 | previous-revoke-pending: HTTP 500 orphan | {"id":1,"name":"cur","orphan":{"name":"orph"}} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
        ],
        "audit": [],
        "logs": [],
        "outcome": {
          "error": {
            "code": "revoke-failed",
            "grantId": "<grant1>",
            "message": "forge grant <grant1>: a superseded token could not be revoked: HTTP 500 orphan",
            "name": "ForgeApiGrantError",
            "status": 502,
          },
        },
        "trace": [
          [
            "provider.revoke <occupant-handle> {"id":2,"name":"prev"}",
            "delivered | g1 | previous-revoke-pending: earlier | {"id":1,"name":"cur","orphan":{"name":"orph"},"previous":{"id":2,"name":"prev","disposition":"revoke"}} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
          [
            "provider.revoke <occupant-handle> {"name":"orph"}",
            "delivered | g1 | previous-revoke-pending: earlier | {"id":1,"name":"cur","orphan":{"name":"orph"},"previous":{"id":2,"name":"prev","disposition":"revoke"}} | no-blob | delivered@2030-01-01T00:00:00.000Z | - | separate-user | - | - | read:[] | station",
          ],
        ],
      },
    }
  `);
});
