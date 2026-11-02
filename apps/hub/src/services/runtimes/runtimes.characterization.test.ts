/**
 * Characterization: the exact traffic of the runtime provisioning service, pinned before it splits.
 *
 * routes/runtimes.test.ts proves the behaviours one by one through the routes (evidence-only
 * `online` and `stopped`, the no-op start, rotation, the unobserved sweep). This file pins the
 * WHOLE of what each exported operation does, as it is today, so a restructure that moves the
 * code cannot change any of it unnoticed:
 *
 *   - every driver call (provision / start / stop / status / destroy), in order, with its
 *     arguments, and the runtime row as the driver sees it at that moment (which is how the
 *     writes made BEFORE a driver call are pinned: `provisioning`, `stopping`, the claim);
 *   - the row after the operation (status, reason, external id, instance clock, node);
 *   - the enrolment tokens minted for the runtime;
 *   - the log lines it writes, and the error (message and HTTP status) it throws;
 *   - what each sweep returns and writes, for each branch it has.
 *
 * Each test makes its own rows and deletes them, so none depends on another or on file order.
 * Volatile values (ids, tokens, times) are replaced by placeholders before comparing.
 * Uses the local Docker test-postgres (localhost:5434).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod";
process.env.NODE_ENV = "test";

import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, rawSql } from "../../db/drizzle";
import { BOOTSTRAP_TENANT_ID } from "../../db/schema/tenants";
import { enrollmentTokens, nodes, provisionedRuntimes } from "../../db/schema/nodes";
import { createTestUser, deleteTestUsers } from "../../../tests/helpers/database";
import { ensurePgMigrations } from "../../../tests/helpers/pg-migrations";
import { registerProvisioner } from "../provisioner/registry";
import type { LifecycleResult, RuntimeProvisioner, RuntimeState } from "../provisioner/types";
import {
  completeRuntimeStartForNode,
  createRuntime,
  destroyRuntime,
  getRuntime,
  listRuntimes,
  nodesWithFixedImage,
  reprovisionRuntime,
  ROTATION_MARGIN_MS,
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  UNOBSERVED_GRACE_MS,
  startRuntime,
  stopRuntime,
  sweepExpiringRuntimes,
  sweepStalledRuntimeStarts,
  sweepStalledRuntimeStops,
  sweepUnobservedRuntimes,
  enabledProviders,
  providerManifests,
} from "./runtimes";

const TEST_USER = "test-user-rtchar-001";
const SCOPE = { tenantId: BOOTSTRAP_TENANT_ID };
const OTHER_SCOPE = { tenantId: "fleet_00000000000000c0ffee" };

// ─── Recording fakes ────────────────────────────────────────────────────────────

type Trace = unknown[];
let trace: Trace = [];

/** What each fake answers next; reset before every test. */
interface Knobs {
  provisionFails: boolean;
  startAnswer: "ok" | "already" | "fails";
  stopFails: boolean;
  state: RuntimeState | "throws";
  destroyFails: boolean;
}
let knobs: Knobs;
const freshKnobs = (): Knobs => ({
  provisionFails: false,
  startAnswer: "ok",
  stopFails: false,
  state: "stopped",
  destroyFails: false,
});

/** Provisions per runtime, so an external id names its row and its generation. */
const provisionCount = new Map<string, number>();

/** The row as a driver call sees it, so writes made before the call are pinned too. */
async function rowSeen(runtimeId: string | null) {
  if (!runtimeId) return null;
  const [row] = await db.select().from(provisionedRuntimes).where(eq(provisionedRuntimes.id, runtimeId));
  if (!row) return null;
  return { status: row.status, statusReason: row.statusReason, externalId: row.externalId };
}

async function runtimeForExternal(externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: provisionedRuntimes.id })
    .from(provisionedRuntimes)
    .where(eq(provisionedRuntimes.externalId, externalId));
  return row?.id ?? null;
}

async function tokensFor(runtimeId: string): Promise<number> {
  const rows = await db
    .select({ id: enrollmentTokens.id })
    .from(enrollmentTokens)
    .where(eq(enrollmentTokens.provisionedRuntimeId, runtimeId));
  return rows.length;
}

function makeFake(
  provider: string,
  shape: {
    stopSemantics: "resumable" | "terminal";
    maxLifetimeMs: number | null;
    workspaceStorage: "rootfs" | "volume";
    imageBinding: "per-instance" | "fixed";
    start: boolean;
    stop: boolean;
    status: boolean;
  }
): RuntimeProvisioner {
  const fake: RuntimeProvisioner = {
    provider,
    manifest: {
      provider,
      workspaceStorage: shape.workspaceStorage,
      stopSemantics: shape.stopSemantics,
      maxLifetimeMs: shape.maxLifetimeMs,
      imageBinding: shape.imageBinding,
      supportedTiers: ["small", "medium", "large"],
      tierMemoryMb: { small: 1024, medium: 2048, large: 4096 },
      idleBehaviour: "never",
      lifecycle: [...(shape.start ? ["start" as const] : []), ...(shape.stop ? ["stop" as const] : [])],
    },
    async provision(spec) {
      const n = (provisionCount.get(spec.runtimeId) ?? 0) + 1;
      provisionCount.set(spec.runtimeId, n);
      trace.push([
        `${provider}.provision`,
        { ...spec, enrollToken: spec.enrollToken ? "<token>" : "" },
        await rowSeen(spec.runtimeId),
        { tokens: await tokensFor(spec.runtimeId) },
      ]);
      if (knobs.provisionFails) throw new Error(`${provider}: provision refused`);
      const externalId = `ext-${provider}-${spec.runtimeId}-${n}`;
      extToId.set(externalId, spec.runtimeId);
      return { externalId, runtime: "runc" };
    },
    async destroy(externalId) {
      trace.push([`${provider}.destroy`, externalId, await rowSeen(await runtimeForExternal(externalId))]);
      if (knobs.destroyFails) throw new Error(`${provider}: destroy refused`);
    },
  };
  if (shape.start) {
    fake.start = async (externalId): Promise<LifecycleResult> => {
      trace.push([`${provider}.start`, externalId, await rowSeen(await runtimeForExternal(externalId))]);
      if (knobs.startAnswer === "fails") throw new Error(`${provider}: start refused`);
      if (knobs.startAnswer === "already") return { alreadyInTargetState: true, detail: "already running" };
    };
  }
  if (shape.stop) {
    fake.stop = async (externalId): Promise<LifecycleResult> => {
      trace.push([`${provider}.stop`, externalId, await rowSeen(await runtimeForExternal(externalId))]);
      if (knobs.stopFails) throw new Error(`${provider}: stop refused`);
    };
  }
  if (shape.status) {
    fake.status = async (externalId): Promise<RuntimeState> => {
      trace.push([`${provider}.status`, externalId, await rowSeen(await runtimeForExternal(externalId))]);
      if (knobs.state === "throws") throw new Error(`${provider}: status unreachable`);
      return knobs.state;
    };
  }
  return fake;
}

// rcres: resumable, every verb. rcterm: terminal, a 1h ceiling, workspace on a volume.
// rcbare: resumable, no start/stop/status, fixed image. rcroot: terminal, rootfs, 1h ceiling.
const PROVIDERS = ["rcres", "rcterm", "rcbare", "rcroot"] as const;
const flag = (p: string) => `ENABLE_${p.toUpperCase()}_PROVISIONING`;

function registerFakes() {
  registerProvisioner(
    makeFake("rcres", { stopSemantics: "resumable", maxLifetimeMs: null, workspaceStorage: "rootfs", imageBinding: "per-instance", start: true, stop: true, status: true })
  );
  registerProvisioner(
    makeFake("rcterm", { stopSemantics: "terminal", maxLifetimeMs: 3_600_000, workspaceStorage: "volume", imageBinding: "per-instance", start: false, stop: true, status: true })
  );
  registerProvisioner(
    makeFake("rcbare", { stopSemantics: "resumable", maxLifetimeMs: null, workspaceStorage: "rootfs", imageBinding: "fixed", start: false, stop: false, status: false })
  );
  registerProvisioner(
    makeFake("rcroot", { stopSemantics: "terminal", maxLifetimeMs: 3_600_000, workspaceStorage: "rootfs", imageBinding: "per-instance", start: false, stop: true, status: true })
  );
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

const spies: { mockRestore: () => void }[] = [];
function captureLogs() {
  for (const level of ["log", "warn", "error"] as const) {
    const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(" ");
      // Only this file's runtimes: sweeps read every row in the database.
      if (/rc(res|term|bare|root)|ext-rc|node_rtchar/.test(line) || created.some((id) => line.includes(id))) {
        trace.push([`console.${level}`, line]);
      }
    });
    spies.push(spy);
  }
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

let created: string[] = [];
let createdNodes: string[] = [];
let seq = 0;

async function insertRuntime(fields: {
  provider: string;
  status: (typeof provisionedRuntimes.$inferInsert)["status"];
  externalId?: string | null;
  externalStartedAt?: Date | null;
  updatedAt?: Date;
  nodeId?: string | null;
  harness?: string;
  tenantId?: string;
}): Promise<string> {
  seq += 1;
  const id = `rt_rtchar${String(seq).padStart(4, "0")}`;
  await db.insert(provisionedRuntimes).values({
    id,
    tenantId: fields.tenantId ?? BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    provider: fields.provider,
    status: fields.status,
    name: `char-${seq}`,
    resourceTier: "small",
    harness: fields.harness ?? "none",
    externalId: fields.externalId === undefined ? `ext-old-${seq}` : fields.externalId,
    externalStartedAt: fields.externalStartedAt ?? null,
    nodeId: fields.nodeId ?? null,
    runtime: "runc-old",
    createdAt: fields.updatedAt ?? new Date(),
    updatedAt: fields.updatedAt ?? new Date(),
  });
  created.push(id);
  const ext = fields.externalId === undefined ? `ext-old-${seq}` : fields.externalId;
  if (ext) extToId.set(ext, id);
  return id;
}

async function insertNode(status: "online" | "offline", lastSeenAt: Date | null): Promise<string> {
  seq += 1;
  const id = `node_rtchar${String(seq).padStart(4, "0")}`;
  await db.insert(nodes).values({
    id,
    tenantId: BOOTSTRAP_TENANT_ID,
    userId: TEST_USER,
    name: id,
    hostname: id,
    os: "linux",
    arch: "amd64",
    secretHash: "x",
    status,
    lastSeenAt,
  });
  createdNodes.push(id);
  return id;
}

async function rowAfter(id: string) {
  const [row] = await db.select().from(provisionedRuntimes).where(eq(provisionedRuntimes.id, id));
  if (!row) return null;
  return {
    status: row.status,
    statusReason: row.statusReason,
    externalId: row.externalId,
    runtime: row.runtime,
    externalStartedAt: row.externalStartedAt ? "<set>" : null,
    nodeId: row.nodeId,
    tokens: await tokensFor(id),
  };
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    if (!(err instanceof Error)) return { thrown: String(err) };
    return { message: err.message, status: "status" in err ? err.status : undefined };
  }
}

/** Ids and times to placeholders; this file's own ids to stable names. */
function normalize(value: unknown): unknown {
  let text = JSON.stringify(value);
  created.forEach((id, i) => (text = text.split(id).join(`<rt${i + 1}>`)));
  createdNodes.forEach((id, i) => (text = text.split(id).join(`<node${i + 1}>`)));
  text = text
    .replace(/rt_[0-9a-f]{20}/g, "<new-rt>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<time>");
  return JSON.parse(text);
}

const mine = (ids: string[]) => ids.filter((id) => created.includes(id)).toSorted();

/**
 * A sweep reads its rows with no ORDER BY, so the order ACROSS rows is the heap's, not the
 * code's. Re-order what one sweep left in the trace by row (stable, so each row's own calls and
 * lines keep their order), from `traceMark` on.
 */
let traceMark = 0;
const extToId = new Map<string, string>();
function rowKeyOf(entry: unknown): number {
  if (!Array.isArray(entry)) return -1;
  const items: unknown[] = entry;
  const what = String(items[0]);
  const arg = items[1];
  let id: string | undefined;
  if (what.startsWith("console.")) id = created.find((c) => String(arg).includes(c));
  else if (typeof arg === "string") id = extToId.get(arg);
  else if (arg && typeof arg === "object") id = (arg as { runtimeId?: string }).runtimeId;
  return id ? created.indexOf(id) : -1;
}
function byRow(): void {
  const segment = trace.splice(traceMark);
  segment.sort((a, b) => rowKeyOf(a) - rowKeyOf(b));
  trace.push(...segment);
  traceMark = trace.length;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

const savedHubUrl = process.env.PROVISIONING_HUB_URL;

beforeAll(async () => {
  await ensurePgMigrations();
  await createTestUser({ id: TEST_USER, email: "rtchar@example.com", name: "Runtime Characterization" });
  await rawSql`INSERT INTO tenants (id, name) VALUES (${OTHER_SCOPE.tenantId}, 'rtchar other') ON CONFLICT DO NOTHING`;
});

beforeEach(() => {
  for (const p of PROVIDERS) process.env[flag(p)] = "true";
  process.env.PROVISIONING_HUB_URL = "https://hub.rtchar.test";
  registerFakes();
  knobs = freshKnobs();
  trace = [];
  created = [];
  createdNodes = [];
  provisionCount.clear();
  seq = 0;
  traceMark = 0;
  extToId.clear();
  captureLogs();
});

afterEach(async () => {
  for (const s of spies.splice(0)) s.mockRestore();
  await rawSql`DELETE FROM enrollment_tokens    WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM provisioned_runtimes WHERE user_id = ${TEST_USER}`;
  await rawSql`DELETE FROM nodes                WHERE user_id = ${TEST_USER}`;
});

afterAll(async () => {
  for (const p of PROVIDERS) delete process.env[flag(p)];
  delete process.env.ENABLE_RCGHOST_PROVISIONING;
  if (savedHubUrl === undefined) delete process.env.PROVISIONING_HUB_URL;
  else process.env.PROVISIONING_HUB_URL = savedHubUrl;
  await rawSql`DELETE FROM tenants WHERE id = ${OTHER_SCOPE.tenantId}`;
  await deleteTestUsers([TEST_USER]);
});

// ─── createRuntime ────────────────────────────────────────────────────────────

test("createRuntime: the provisioning row and its token before the driver call, the contract after", async () => {
  const result = await createRuntime(TEST_USER, BOOTSTRAP_TENANT_ID, { provider: "rcres", name: "box", resourceTier: "medium" }, "https://req.origin");
  created.push(result.id);
  expect(normalize({ result, trace, row: await rowAfter(result.id) })).toMatchInlineSnapshot(`
    {
      "result": {
        "createdAt": "<time>",
        "externalId": "ext-rcres-<rt1>-1",
        "harness": "none",
        "id": "<rt1>",
        "name": "box",
        "nodeId": null,
        "ownerId": "test-user-rtchar-001",
        "provider": "rcres",
        "resourceTier": "medium",
        "runtime": "runc",
        "status": "provisioning",
        "statusReason": null,
        "updatedAt": "<time>",
      },
      "row": {
        "externalId": "ext-rcres-<rt1>-1",
        "externalStartedAt": "<set>",
        "nodeId": null,
        "runtime": "runc",
        "status": "provisioning",
        "statusReason": null,
        "tokens": 1,
      },
      "trace": [
        [
          "rcres.provision",
          {
            "enrollToken": "<token>",
            "hubUrl": "https://req.origin",
            "image": "agentpod-node:local",
            "name": "box",
            "resourceTier": "medium",
            "runtimeId": "<rt1>",
          },
          {
            "externalId": null,
            "status": "provisioning",
            "statusReason": null,
          },
          {
            "tokens": 1,
          },
        ],
      ],
    }
  `);
});

test("createRuntime: each refusal, what it leaves behind and the status it carries", async () => {
  const out: unknown[] = [];
  const rowsOf = async () =>
    (await db.select().from(provisionedRuntimes).where(eq(provisionedRuntimes.userId, TEST_USER)).orderBy(provisionedRuntimes.provider)).map((r) => {
      created.push(r.id);
      return { provider: r.provider, status: r.status, statusReason: r.statusReason, externalId: r.externalId, startedAt: r.externalStartedAt };
    });

  delete process.env[flag("rcres")];
  out.push(["disabled", await errorOf(createRuntime(TEST_USER, BOOTSTRAP_TENANT_ID, { provider: "rcres", name: "a", resourceTier: "small" }, "https://h"))]);
  process.env[flag("rcres")] = "true";
  out.push(["tier", await errorOf(createRuntime(TEST_USER, BOOTSTRAP_TENANT_ID, { provider: "rcres", name: "a", resourceTier: "small", harness: "opencode" }, "https://h"))]);
  out.push(["rows after the guards", await rowsOf()]);

  process.env.ENABLE_RCGHOST_PROVISIONING = "true";
  out.push(["enabled, no driver", await errorOf(createRuntime(TEST_USER, BOOTSTRAP_TENANT_ID, { provider: "rcghost", name: "g", resourceTier: "small" }, "https://h"))]);
  knobs.provisionFails = true;
  out.push(["driver throws", await errorOf(createRuntime(TEST_USER, BOOTSTRAP_TENANT_ID, { provider: "rcres", name: "f", resourceTier: "large" }, "https://h"))]);
  out.push(["rows", await rowsOf()]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "disabled",
        {
          "message": "provider disabled: rcres",
          "status": 400,
        },
      ],
      [
        "tier",
        {
          "message": "harness "opencode" needs 2048 MB but the rcres "small" tier gives 1024 MB. Choose medium or large.",
          "status": 400,
        },
      ],
      [
        "rows after the guards",
        [],
      ],
      [
        "enabled, no driver",
        {
          "message": "provider not registered: rcghost",
          "status": 400,
        },
      ],
      [
        "driver throws",
        {
          "message": "rcres: provision refused",
          "status": 502,
        },
      ],
      [
        "rows",
        [
          {
            "externalId": null,
            "provider": "rcghost",
            "startedAt": null,
            "status": "error",
            "statusReason": "provider not registered: rcghost",
          },
          {
            "externalId": null,
            "provider": "rcres",
            "startedAt": null,
            "status": "error",
            "statusReason": "the rcres driver failed to provision it: rcres: provision refused",
          },
        ],
      ],
      [
        "trace",
        [
          [
            "rcres.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://h",
              "image": "agentpod-node:local",
              "name": "f",
              "resourceTier": "large",
              "runtimeId": "<rt2>",
            },
            {
              "externalId": null,
              "status": "provisioning",
              "statusReason": null,
            },
            {
              "tokens": 1,
            },
          ],
        ],
      ],
    ]
  `);
});

// ─── list / get / destroy ─────────────────────────────────────────────────────

test("listRuntimes and getRuntime: the workspace's rows, destroyed ones left out", async () => {
  const live = await insertRuntime({ provider: "rcres", status: "online" });
  const gone = await insertRuntime({ provider: "rcres", status: "destroyed" });
  const elsewhere = await insertRuntime({ provider: "rcres", status: "online", tenantId: OTHER_SCOPE.tenantId });
  const listed = (await listRuntimes(SCOPE)).map((r) => r.id).filter((id) => created.includes(id));
  expect(
    normalize({
      listed,
      live: (await getRuntime(SCOPE, live))?.status,
      gone: (await getRuntime(SCOPE, gone))?.status,
      elsewhere: await getRuntime(SCOPE, elsewhere),
      elsewhereInItsOwn: (await listRuntimes(OTHER_SCOPE)).map((r) => r.id).filter((id) => created.includes(id)),
    })
  ).toMatchInlineSnapshot(`
    {
      "elsewhere": null,
      "elsewhereInItsOwn": [
        "<rt3>",
      ],
      "gone": "destroyed",
      "listed": [
        "<rt1>",
      ],
      "live": "online",
    }
  `);
});

test("destroyRuntime: the driver call, the destroyed row, the node removed; and each refusal", async () => {
  const nodeId = await insertNode("online", new Date());
  const id = await insertRuntime({ provider: "rcres", status: "online", nodeId });
  const noDriver = await insertRuntime({ provider: "rcunregistered", status: "online" });
  const noExternal = await insertRuntime({ provider: "rcres", status: "error", externalId: null });
  const failing = await insertRuntime({ provider: "rcres", status: "online" });
  const out: unknown[] = [];
  out.push(["ok", await errorOf(destroyRuntime(SCOPE, id))]);
  out.push(["no driver", await errorOf(destroyRuntime(SCOPE, noDriver))]);
  out.push(["no external id", await errorOf(destroyRuntime(SCOPE, noExternal))]);
  knobs.destroyFails = true;
  out.push(["driver throws", await errorOf(destroyRuntime(SCOPE, failing))]);
  out.push(["other workspace", await errorOf(destroyRuntime(OTHER_SCOPE, failing))]);
  const nodeLeft = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId));
  out.push(["rows", await rowAfter(id), await rowAfter(noDriver), await rowAfter(noExternal), await rowAfter(failing)]);
  out.push(["node left", nodeLeft.length]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "ok",
        "resolved",
      ],
      [
        "no driver",
        "resolved",
      ],
      [
        "no external id",
        "resolved",
      ],
      [
        "driver throws",
        {
          "message": "rcres: destroy refused",
          "status": 502,
        },
      ],
      [
        "other workspace",
        {
          "message": "runtime not found",
          "status": 404,
        },
      ],
      [
        "rows",
        {
          "externalId": "ext-old-2",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "destroyed",
          "statusReason": null,
          "tokens": 0,
        },
        {
          "externalId": "ext-old-3",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "destroyed",
          "statusReason": null,
          "tokens": 0,
        },
        {
          "externalId": null,
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "destroyed",
          "statusReason": null,
          "tokens": 0,
        },
        {
          "externalId": "ext-old-5",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "node left",
        0,
      ],
      [
        "trace",
        [
          [
            "rcres.destroy",
            "ext-old-2",
            {
              "externalId": "ext-old-2",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.destroy",
            "ext-old-5",
            {
              "externalId": "ext-old-5",
              "status": "online",
              "statusReason": null,
            },
          ],
        ],
      ],
    ]
  `);
});

// ─── start ────────────────────────────────────────────────────────────────────

test("startRuntime on a resumable driver: starting, the no-op, and each refusal", async () => {
  const stopped = await insertRuntime({ provider: "rcres", status: "stopped" });
  const online = await insertRuntime({ provider: "rcres", status: "online" });
  const noStart = await insertRuntime({ provider: "rcbare", status: "stopped" });
  const noExternal = await insertRuntime({ provider: "rcres", status: "stopped", externalId: null });
  const noDriver = await insertRuntime({ provider: "rcunregistered", status: "stopped" });
  await rawSql`UPDATE provisioned_runtimes SET status_reason = 'old reason' WHERE id = ${stopped}`;
  const out: unknown[] = [];
  out.push(["ok", await errorOf(startRuntime(SCOPE, stopped)), await rowAfter(stopped)]);
  knobs.startAnswer = "already";
  out.push(["already", await errorOf(startRuntime(SCOPE, online)), await rowAfter(online)]);
  knobs.startAnswer = "fails";
  out.push(["fails", await errorOf(startRuntime(SCOPE, online)), await rowAfter(online)]);
  out.push(["no start", await errorOf(startRuntime(SCOPE, noStart))]);
  out.push(["no external id", await errorOf(startRuntime(SCOPE, noExternal))]);
  out.push(["no driver", await errorOf(startRuntime(SCOPE, noDriver))]);
  out.push(["not found", await errorOf(startRuntime(OTHER_SCOPE, stopped))]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "ok",
        "resolved",
        {
          "externalId": "ext-old-1",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "starting",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "already",
        "resolved",
        {
          "externalId": "ext-old-2",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "fails",
        {
          "message": "rcres: start refused",
        },
        {
          "externalId": "ext-old-2",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "no start",
        {
          "message": "provider rcbare does not support start",
          "status": 400,
        },
      ],
      [
        "no external id",
        {
          "message": "runtime has no external id",
          "status": 400,
        },
      ],
      [
        "no driver",
        {
          "message": "provider not available: rcunregistered",
          "status": 502,
        },
      ],
      [
        "not found",
        {
          "message": "runtime not found",
          "status": 404,
        },
      ],
      [
        "trace",
        [
          [
            "rcres.start",
            "ext-old-1",
            {
              "externalId": "ext-old-1",
              "status": "stopped",
              "statusReason": "old reason",
            },
          ],
          [
            "rcres.start",
            "ext-old-2",
            {
              "externalId": "ext-old-2",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtimes] <rt2>: start was a no-op — rcres reports it already running",
          ],
          [
            "rcres.start",
            "ext-old-2",
            {
              "externalId": "ext-old-2",
              "status": "online",
              "statusReason": null,
            },
          ],
        ],
      ],
    ]
  `);
});

test("startRuntime on a terminal driver: terminate first, a fresh token, re-create against the same id", async () => {
  const id = await insertRuntime({ provider: "rcterm", status: "stopped" });
  const out: unknown[] = [];
  out.push(["ok", await errorOf(startRuntime(SCOPE, id)), await rowAfter(id)]);

  knobs.stopFails = true;
  out.push(["terminate fails", await errorOf(startRuntime(SCOPE, id)), await rowAfter(id)]);

  knobs.provisionFails = true;
  out.push(["create fails too", await errorOf(startRuntime(SCOPE, id)), await rowAfter(id)]);

  knobs.stopFails = false;
  knobs.provisionFails = false;
  delete process.env.PROVISIONING_HUB_URL;
  out.push(["no hub url", await errorOf(startRuntime(SCOPE, id)), await rowAfter(id)]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "ok",
        "resolved",
        {
          "externalId": "ext-rcterm-<rt1>-1",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "starting",
          "statusReason": "re-created: this substrate has no start, so a start is a new instance",
          "tokens": 1,
        },
      ],
      [
        "terminate fails",
        "resolved",
        {
          "externalId": "ext-rcterm-<rt1>-2",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "starting",
          "statusReason": "re-created: this substrate has no start, so a start is a new instance. the previous instance (ext-rcterm-<rt1>-1) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
          "tokens": 2,
        },
      ],
      [
        "create fails too",
        {
          "message": "rcterm: provision refused",
          "status": 502,
        },
        {
          "externalId": "ext-rcterm-<rt1>-2",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "error",
          "statusReason": "the rcterm driver failed to re-create it: rcterm: provision refused. the previous instance (ext-rcterm-<rt1>-2) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
          "tokens": 3,
        },
      ],
      [
        "no hub url",
        {
          "message": "PROVISIONING_HUB_URL is not set, so a runtime cannot be re-created — the new container would have no hub to enrol against",
          "status": 502,
        },
        {
          "externalId": "ext-rcterm-<rt1>-2",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "error",
          "statusReason": "the rcterm driver failed to re-create it: rcterm: provision refused. the previous instance (ext-rcterm-<rt1>-2) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
          "tokens": 3,
        },
      ],
      [
        "trace",
        [
          [
            "rcterm.stop",
            "ext-old-1",
            {
              "externalId": "ext-old-1",
              "status": "stopped",
              "statusReason": null,
            },
          ],
          [
            "rcterm.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-1",
              "resourceTier": "small",
              "runtimeId": "<rt1>",
            },
            {
              "externalId": "ext-old-1",
              "status": "stopped",
              "statusReason": null,
            },
            {
              "tokens": 1,
            },
          ],
          [
            "rcterm.stop",
            "ext-rcterm-<rt1>-1",
            {
              "externalId": "ext-rcterm-<rt1>-1",
              "status": "starting",
              "statusReason": "re-created: this substrate has no start, so a start is a new instance",
            },
          ],
          [
            "console.warn",
            "[runtimes] <rt1>: the previous instance (ext-rcterm-<rt1>-1) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
          ],
          [
            "rcterm.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-1",
              "resourceTier": "small",
              "runtimeId": "<rt1>",
            },
            {
              "externalId": "ext-rcterm-<rt1>-1",
              "status": "starting",
              "statusReason": "re-created: this substrate has no start, so a start is a new instance",
            },
            {
              "tokens": 2,
            },
          ],
          [
            "rcterm.stop",
            "ext-rcterm-<rt1>-2",
            {
              "externalId": "ext-rcterm-<rt1>-2",
              "status": "starting",
              "statusReason": "re-created: this substrate has no start, so a start is a new instance. the previous instance (ext-rcterm-<rt1>-1) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
            },
          ],
          [
            "console.warn",
            "[runtimes] <rt1>: the previous instance (ext-rcterm-<rt1>-2) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
          ],
          [
            "rcterm.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-1",
              "resourceTier": "small",
              "runtimeId": "<rt1>",
            },
            {
              "externalId": "ext-rcterm-<rt1>-2",
              "status": "starting",
              "statusReason": "re-created: this substrate has no start, so a start is a new instance. the previous instance (ext-rcterm-<rt1>-1) could not be terminated: rcterm: stop refused — check the substrate, it may still be billing",
            },
            {
              "tokens": 3,
            },
          ],
        ],
      ],
    ]
  `);
});

test("reprovisionRuntime with no driver: refused before anything is minted", async () => {
  const id = await insertRuntime({ provider: "rcunregistered", status: "online" });
  const [row] = await db.select().from(provisionedRuntimes).where(eq(provisionedRuntimes.id, id));
  if (!row) throw new Error("row missing");
  expect(normalize([await errorOf(reprovisionRuntime(row, "why")), await rowAfter(id), trace])).toMatchInlineSnapshot(`
    [
      {
        "message": "provider not available: rcunregistered",
        "status": 502,
      },
      {
        "externalId": "ext-old-1",
        "externalStartedAt": null,
        "nodeId": null,
        "runtime": "runc-old",
        "status": "online",
        "statusReason": null,
        "tokens": 0,
      },
      [],
    ]
  `);
});

// ─── stop ─────────────────────────────────────────────────────────────────────

test("stopRuntime: stopping before the probe, stopped only on the substrate's word", async () => {
  const confirmed = await insertRuntime({ provider: "rcres", status: "online" });
  const running = await insertRuntime({ provider: "rcres", status: "online" });
  const probeThrows = await insertRuntime({ provider: "rcres", status: "online" });
  const unverifiable = await insertRuntime({ provider: "rcterm", status: "online" });
  const noStop = await insertRuntime({ provider: "rcbare", status: "online" });
  const noExternal = await insertRuntime({ provider: "rcres", status: "online", externalId: null });
  const out: unknown[] = [];
  out.push(["confirmed", await errorOf(stopRuntime(SCOPE, confirmed)), await rowAfter(confirmed)]);
  knobs.state = "running";
  out.push(["running", await errorOf(stopRuntime(SCOPE, running)), await rowAfter(running)]);
  knobs.state = "throws";
  out.push(["probe throws", await errorOf(stopRuntime(SCOPE, probeThrows)), await rowAfter(probeThrows)]);
  // rcterm has a status(); swap in a driver without one for the unverified write.
  registerProvisioner(
    makeFake("rcterm", { stopSemantics: "terminal", maxLifetimeMs: 3_600_000, workspaceStorage: "volume", imageBinding: "per-instance", start: false, stop: true, status: false })
  );
  out.push(["no status()", await errorOf(stopRuntime(SCOPE, unverifiable)), await rowAfter(unverifiable)]);
  knobs.stopFails = true;
  out.push(["stop throws", await errorOf(stopRuntime(SCOPE, confirmed)), await rowAfter(confirmed)]);
  out.push(["no stop", await errorOf(stopRuntime(SCOPE, noStop))]);
  out.push(["no external id", await errorOf(stopRuntime(SCOPE, noExternal))]);
  out.push(["not found", await errorOf(stopRuntime(OTHER_SCOPE, confirmed))]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "confirmed",
        "resolved",
        {
          "externalId": "ext-old-1",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopped",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "running",
        "resolved",
        {
          "externalId": "ext-old-2",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopping",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "probe throws",
        "resolved",
        {
          "externalId": "ext-old-3",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopping",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "no status()",
        "resolved",
        {
          "externalId": "ext-old-4",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopped",
          "statusReason": "unverified: the rcterm driver cannot report container state, so the hub knows only that the stop request was accepted — check the substrate if this runtime must not be billing",
          "tokens": 0,
        },
      ],
      [
        "stop throws",
        {
          "message": "rcres: stop refused",
        },
        {
          "externalId": "ext-old-1",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopped",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "no stop",
        {
          "message": "provider rcbare does not support stop",
          "status": 400,
        },
      ],
      [
        "no external id",
        {
          "message": "runtime has no external id",
          "status": 400,
        },
      ],
      [
        "not found",
        {
          "message": "runtime not found",
          "status": 404,
        },
      ],
      [
        "trace",
        [
          [
            "rcres.stop",
            "ext-old-1",
            {
              "externalId": "ext-old-1",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.status",
            "ext-old-1",
            {
              "externalId": "ext-old-1",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "rcres.stop",
            "ext-old-2",
            {
              "externalId": "ext-old-2",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.status",
            "ext-old-2",
            {
              "externalId": "ext-old-2",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "rcres.stop",
            "ext-old-3",
            {
              "externalId": "ext-old-3",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.status",
            "ext-old-3",
            {
              "externalId": "ext-old-3",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "console.warn",
            "[runtimes] rcres status(ext-old-3) failed: rcres: status unreachable",
          ],
          [
            "rcterm.stop",
            "ext-old-4",
            {
              "externalId": "ext-old-4",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.stop",
            "ext-old-1",
            {
              "externalId": "ext-old-1",
              "status": "stopped",
              "statusReason": null,
            },
          ],
        ],
      ],
    ]
  `);
});

// ─── completeRuntimeStartForNode ──────────────────────────────────────────────

test("completeRuntimeStartForNode: only this node's starting runtime goes online", async () => {
  const nodeId = await insertNode("online", new Date());
  const otherNode = await insertNode("online", new Date());
  const starting = await insertRuntime({ provider: "rcres", status: "starting", nodeId });
  const stopped = await insertRuntime({ provider: "rcres", status: "stopped", nodeId: otherNode });
  await rawSql`UPDATE provisioned_runtimes SET status_reason = 'never came back' WHERE id = ${starting}`;
  const flipped = await completeRuntimeStartForNode(nodeId);
  const again = await completeRuntimeStartForNode(nodeId);
  const other = await completeRuntimeStartForNode(otherNode);
  expect(normalize({ flipped, again, other, starting: await rowAfter(starting), stopped: await rowAfter(stopped), trace })).toMatchInlineSnapshot(`
    {
      "again": [],
      "flipped": [
        "<rt1>",
      ],
      "other": [],
      "starting": {
        "externalId": "ext-old-3",
        "externalStartedAt": null,
        "nodeId": "<node1>",
        "runtime": "runc-old",
        "status": "online",
        "statusReason": null,
        "tokens": 0,
      },
      "stopped": {
        "externalId": "ext-old-4",
        "externalStartedAt": null,
        "nodeId": "<node2>",
        "runtime": "runc-old",
        "status": "stopped",
        "statusReason": null,
        "tokens": 0,
      },
      "trace": [
        [
          "console.log",
          "[runtimes] <rt1> starting → online (node <node1> reconnected)",
        ],
      ],
    }
  `);
});

// ─── The sweeps ───────────────────────────────────────────────────────────────

test("sweepStalledRuntimeStarts: starting and provisioning past the timeout, with an external id", async () => {
  const now = Date.now();
  const old = new Date(now - START_TIMEOUT_MS - 1_000);
  const starting = await insertRuntime({ provider: "rcres", status: "starting", updatedAt: old });
  const provisioning = await insertRuntime({ provider: "rcres", status: "provisioning", updatedAt: old });
  const recent = await insertRuntime({ provider: "rcres", status: "starting", updatedAt: new Date(now - 1_000) });
  const noExternal = await insertRuntime({ provider: "rcres", status: "provisioning", updatedAt: old, externalId: null });
  const asleep = await insertRuntime({ provider: "rcres", status: "asleep", updatedAt: old });
  const expired = mine(await sweepStalledRuntimeStarts(now));
  byRow();
  const rows = await Promise.all([starting, provisioning, recent, noExternal, asleep].map(async (id) => [id, (await rowAfter(id))?.status, (await rowAfter(id))?.statusReason]));
  expect(normalize({ expired, rows, trace })).toMatchInlineSnapshot(`
    {
      "expired": [
        "<rt1>",
        "<rt2>",
      ],
      "rows": [
        [
          "<rt1>",
          "error",
          "no node enrolled within 2m of the start request — the container was asked to run but never came back (check the substrate's container logs)",
        ],
        [
          "<rt2>",
          "error",
          "no node enrolled within 2m of provisioning — the container was asked to run but never came back (check the substrate's container logs)",
        ],
        [
          "<rt3>",
          "starting",
          null,
        ],
        [
          "<rt4>",
          "provisioning",
          null,
        ],
        [
          "<rt5>",
          "asleep",
          null,
        ],
      ],
      "trace": [
        [
          "console.log",
          "[runtime-sweeper] <rt1> starting → error (no node enrolled)",
        ],
        [
          "console.log",
          "[runtime-sweeper] <rt2> provisioning → error (no node enrolled)",
        ],
      ],
    }
  `);
});

test("sweepStalledRuntimeStops: confirmed at any age, an error past the timeout, left alone before it", async () => {
  const now = Date.now();
  const old = new Date(now - STOP_TIMEOUT_MS - 1_000);
  const fresh = new Date(now - 1_000);
  const confirmedFresh = await insertRuntime({ provider: "rcres", status: "stopping", updatedAt: fresh, externalId: "ext-stop-confirm" });
  const out: unknown[] = [];
  const sweep0 = await sweepStalledRuntimeStops(now);
  out.push(["stopped", { stopped: mine(sweep0.stopped), failed: mine(sweep0.failed) }]);
  byRow();
  knobs.state = "running";
  const runningOld = await insertRuntime({ provider: "rcres", status: "stopping", updatedAt: old, externalId: "ext-stop-running" });
  const runningFresh = await insertRuntime({ provider: "rcres", status: "stopping", updatedAt: fresh, externalId: "ext-stop-running-fresh" });
  const noDriverOld = await insertRuntime({ provider: "rcunregistered", status: "stopping", updatedAt: old });
  const sweep = await sweepStalledRuntimeStops(now);
  byRow();
  out.push(["running", { stopped: mine(sweep.stopped), failed: mine(sweep.failed) }]);
  knobs.state = "unknown";
  const unknownOld = await insertRuntime({ provider: "rcres", status: "stopping", updatedAt: old, externalId: "ext-stop-unknown" });
  const sweep2 = await sweepStalledRuntimeStops(now);
  byRow();
  out.push(["unknown", { stopped: mine(sweep2.stopped), failed: mine(sweep2.failed) }]);
  for (const id of [confirmedFresh, runningOld, runningFresh, noDriverOld, unknownOld]) {
    const row = await rowAfter(id);
    out.push([id, row?.status, row?.statusReason]);
  }
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "stopped",
        {
          "failed": [],
          "stopped": [
            "<rt1>",
          ],
        },
      ],
      [
        "running",
        {
          "failed": [
            "<rt2>",
            "<rt4>",
          ],
          "stopped": [],
        },
      ],
      [
        "unknown",
        {
          "failed": [
            "<rt5>",
          ],
          "stopped": [],
        },
      ],
      [
        "<rt1>",
        "stopped",
        null,
      ],
      [
        "<rt2>",
        "error",
        "the stop was not confirmed within 5m: the rcres substrate still reports it running — it may still be billing. Check the substrate before assuming this runtime has stopped costing money",
      ],
      [
        "<rt3>",
        "stopping",
        null,
      ],
      [
        "<rt4>",
        "error",
        "the stop was not confirmed within 5m: the rcunregistered substrate did not report its state (no driver is registered to ask). Check the substrate before assuming this runtime has stopped costing money",
      ],
      [
        "<rt5>",
        "error",
        "the stop was not confirmed within 5m: the rcres substrate did not report its state. Check the substrate before assuming this runtime has stopped costing money",
      ],
      [
        "trace",
        [
          [
            "rcres.status",
            "ext-stop-confirm",
            {
              "externalId": "ext-stop-confirm",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt1> stopping → stopped (substrate confirmed)",
          ],
          [
            "rcres.status",
            "ext-stop-running",
            {
              "externalId": "ext-stop-running",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt2> stopping → error (stop unconfirmed, running)",
          ],
          [
            "rcres.status",
            "ext-stop-running-fresh",
            {
              "externalId": "ext-stop-running-fresh",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt4> stopping → error (stop unconfirmed, unknown)",
          ],
          [
            "rcres.status",
            "ext-stop-running-fresh",
            {
              "externalId": "ext-stop-running-fresh",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "rcres.status",
            "ext-stop-unknown",
            {
              "externalId": "ext-stop-unknown",
              "status": "stopping",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt5> stopping → error (stop unconfirmed, unknown)",
          ],
        ],
      ],
    ]
  `);
});

test("sweepExpiringRuntimes: the claim, the terminate-then-create, the reason per workspace storage, the failure", async () => {
  const now = Date.now();
  const due = new Date(now - 3_600_000 + ROTATION_MARGIN_MS - 1_000);
  const notDue = new Date(now - 60_000);
  const volume = await insertRuntime({ provider: "rcterm", status: "online", externalStartedAt: due, externalId: "ext-rot-volume" });
  const rootfs = await insertRuntime({ provider: "rcroot", status: "starting", externalStartedAt: due, externalId: "ext-rot-rootfs" });
  const young = await insertRuntime({ provider: "rcterm", status: "online", externalStartedAt: notDue, externalId: "ext-rot-young" });
  const stopped = await insertRuntime({ provider: "rcterm", status: "stopped", externalStartedAt: due, externalId: "ext-rot-stopped" });
  const noCeiling = await insertRuntime({ provider: "rcres", status: "online", externalStartedAt: new Date(0), externalId: "ext-rot-noceiling" });
  const noClock = await insertRuntime({ provider: "rcterm", status: "online", externalId: "ext-rot-noclock" });
  const out: unknown[] = [];
  out.push(["rotated", mine(await sweepExpiringRuntimes(now))]);
  byRow();
  knobs.provisionFails = true;
  const failing = await insertRuntime({ provider: "rcterm", status: "online", externalStartedAt: due, externalId: "ext-rot-failing" });
  out.push(["rotated when the create fails", mine(await sweepExpiringRuntimes(now))]);
  byRow();
  for (const id of [volume, rootfs, young, stopped, noCeiling, noClock, failing]) out.push([id, await rowAfter(id)]);
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "rotated",
        [
          "<rt1>",
          "<rt2>",
        ],
      ],
      [
        "rotated when the create fails",
        [],
      ],
      [
        "<rt1>",
        {
          "externalId": "ext-rcterm-<rt1>-1",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "starting",
          "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over",
          "tokens": 1,
        },
      ],
      [
        "<rt2>",
        {
          "externalId": "ext-rcroot-<rt2>-1",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc",
          "status": "starting",
          "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the instance's disk does not survive, so check the workspace",
          "tokens": 1,
        },
      ],
      [
        "<rt3>",
        {
          "externalId": "ext-rot-young",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "<rt4>",
        {
          "externalId": "ext-rot-stopped",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc-old",
          "status": "stopped",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "<rt5>",
        {
          "externalId": "ext-rot-noceiling",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "<rt6>",
        {
          "externalId": "ext-rot-noclock",
          "externalStartedAt": null,
          "nodeId": null,
          "runtime": "runc-old",
          "status": "online",
          "statusReason": null,
          "tokens": 0,
        },
      ],
      [
        "<rt7>",
        {
          "externalId": "ext-rot-failing",
          "externalStartedAt": "<set>",
          "nodeId": null,
          "runtime": "runc-old",
          "status": "error",
          "statusReason": "could not re-create this runtime before its 1h lifetime ceiling: rcterm: provision refused",
          "tokens": 1,
        },
      ],
      [
        "trace",
        [
          [
            "rcterm.stop",
            "ext-rot-volume",
            {
              "externalId": "ext-rot-volume",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over",
            },
          ],
          [
            "rcterm.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-1",
              "resourceTier": "small",
              "runtimeId": "<rt1>",
            },
            {
              "externalId": "ext-rot-volume",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over",
            },
            {
              "tokens": 1,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt1> rotated ahead of the 1h rcterm ceiling",
          ],
          [
            "rcroot.stop",
            "ext-rot-rootfs",
            {
              "externalId": "ext-rot-rootfs",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the instance's disk does not survive, so check the workspace",
            },
          ],
          [
            "rcroot.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-2",
              "resourceTier": "small",
              "runtimeId": "<rt2>",
            },
            {
              "externalId": "ext-rot-rootfs",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the instance's disk does not survive, so check the workspace",
            },
            {
              "tokens": 1,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt2> rotated ahead of the 1h rcroot ceiling",
          ],
          [
            "rcterm.stop",
            "ext-rot-failing",
            {
              "externalId": "ext-rot-failing",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over",
            },
          ],
          [
            "rcterm.provision",
            {
              "enrollToken": "<token>",
              "hubUrl": "https://hub.rtchar.test",
              "image": "agentpod-node:local",
              "name": "char-7",
              "resourceTier": "small",
              "runtimeId": "<rt7>",
            },
            {
              "externalId": "ext-rot-failing",
              "status": "provisioning",
              "statusReason": "re-created before this substrate's 1h instance lifetime ceiling destroyed it — the workspace is anchored outside the instance and carries over",
            },
            {
              "tokens": 1,
            },
          ],
          [
            "console.error",
            "[runtime-sweeper] <rt7> rotation failed: rcterm: provision refused",
          ],
        ],
      ],
    ]
  `);
});

test("sweepUnobservedRuntimes: asleep, stopped, annotated or left alone, by the substrate's answer", async () => {
  const now = Date.now();
  const longAgo = new Date(now - UNOBSERVED_GRACE_MS - 60_000);
  const n = async () => insertNode("offline", longAgo);
  const resumableDown = await insertRuntime({ provider: "rcres", status: "online", nodeId: await n(), externalId: "ext-unobs-res" });
  const terminalDown = await insertRuntime({ provider: "rcterm", status: "online", nodeId: await n(), externalId: "ext-unobs-term" });
  const noStatus = await insertRuntime({ provider: "rcbare", status: "online", nodeId: await n(), externalId: "ext-unobs-bare" });
  const noDriver = await insertRuntime({ provider: "rcunregistered", status: "online", nodeId: await n(), externalId: "ext-unobs-none" });
  const recentNode = await insertRuntime({ provider: "rcres", status: "online", nodeId: await insertNode("offline", new Date(now - 1_000)), externalId: "ext-unobs-recent" });
  const out: unknown[] = [];
  const first = await sweepUnobservedRuntimes(now);
  byRow();
  out.push(["stopped", { reconciled: mine(first.reconciled), unverified: mine(first.unverified) }]);
  knobs.state = "running";
  const running = await insertRuntime({ provider: "rcres", status: "online", nodeId: await n(), externalId: "ext-unobs-running" });
  knobs.state = "unknown";
  const second = await sweepUnobservedRuntimes(now);
  byRow();
  out.push(["unknown", { reconciled: mine(second.reconciled), unverified: mine(second.unverified) }]);
  knobs.state = "running";
  const third = await sweepUnobservedRuntimes(now);
  byRow();
  out.push(["running", { reconciled: mine(third.reconciled), unverified: mine(third.unverified) }]);
  for (const id of [resumableDown, terminalDown, noStatus, noDriver, recentNode, running]) {
    const row = await rowAfter(id);
    out.push([id, row?.status, row?.statusReason]);
  }
  out.push(["trace", trace]);
  expect(normalize(out)).toMatchInlineSnapshot(`
    [
      [
        "stopped",
        {
          "reconciled": [
            "<rt1>",
            "<rt2>",
          ],
          "unverified": [
            "<rt3>",
            "<rt4>",
          ],
        },
      ],
      [
        "unknown",
        {
          "reconciled": [],
          "unverified": [
            "<rt3>",
            "<rt4>",
            "<rt6>",
          ],
        },
      ],
      [
        "running",
        {
          "reconciled": [],
          "unverified": [
            "<rt3>",
            "<rt4>",
          ],
        },
      ],
      [
        "<rt1>",
        "asleep",
        "its node stopped reporting and the rcres substrate confirms the container is down — start it to wake it, do not reprovision (that discards the workspace archive)",
      ],
      [
        "<rt2>",
        "stopped",
        null,
      ],
      [
        "<rt3>",
        "online",
        "its node has been unseen for over 10m and the rcbare driver cannot report container state — this runtime may not exist, and may still be billing",
      ],
      [
        "<rt4>",
        "online",
        "its node has been unseen for over 10m and no driver is registered for rcunregistered to ask — this runtime may not exist, and may still be billing",
      ],
      [
        "<rt5>",
        "online",
        null,
      ],
      [
        "<rt6>",
        "online",
        "its node has been unseen for over 10m and the rcres substrate did not answer — this runtime may not exist, and may still be billing",
      ],
      [
        "trace",
        [
          [
            "rcres.status",
            "ext-unobs-res",
            {
              "externalId": "ext-unobs-res",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt1> online → asleep (rcres confirmed the container is down)",
          ],
          [
            "rcterm.status",
            "ext-unobs-term",
            {
              "externalId": "ext-unobs-term",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "console.log",
            "[runtime-sweeper] <rt2> online → stopped (rcterm confirmed the container is down)",
          ],
          [
            "rcres.status",
            "ext-unobs-running",
            {
              "externalId": "ext-unobs-running",
              "status": "online",
              "statusReason": null,
            },
          ],
          [
            "rcres.status",
            "ext-unobs-running",
            {
              "externalId": "ext-unobs-running",
              "status": "online",
              "statusReason": "its node has been unseen for over 10m and the rcres substrate did not answer — this runtime may not exist, and may still be billing",
            },
          ],
        ],
      ],
    ]
  `);
});

// ─── nodesWithFixedImage and the re-exports ───────────────────────────────────

test("nodesWithFixedImage, and the names re-exported from the provisioner and image modules", async () => {
  const fixedNode = await insertNode("online", new Date());
  const perInstanceNode = await insertNode("online", new Date());
  const unknownNode = await insertNode("online", new Date());
  await insertRuntime({ provider: "rcbare", status: "online", nodeId: fixedNode });
  await insertRuntime({ provider: "rcres", status: "online", nodeId: perInstanceNode });
  await insertRuntime({ provider: "rcunregistered", status: "online", nodeId: unknownNode });
  const fixed = [...(await nodesWithFixedImage(BOOTSTRAP_TENANT_ID))].filter((id) => createdNodes.includes(id));
  const elsewhere = [...(await nodesWithFixedImage(OTHER_SCOPE.tenantId))];
  expect(
    normalize({
      fixed,
      elsewhere,
      enabled: enabledProviders().filter((p) => p.startsWith("rc")),
      manifests: providerManifests()
        .filter((m) => m.provider.startsWith("rc"))
        .map((m) => [m.provider, m.stopSemantics, m.imageBinding, m.lifecycle]),
      constants: { START_TIMEOUT_MS, STOP_TIMEOUT_MS, ROTATION_MARGIN_MS, UNOBSERVED_GRACE_MS },
    })
  ).toMatchInlineSnapshot(`
    {
      "constants": {
        "ROTATION_MARGIN_MS": 1800000,
        "START_TIMEOUT_MS": 120000,
        "STOP_TIMEOUT_MS": 300000,
        "UNOBSERVED_GRACE_MS": 600000,
      },
      "elsewhere": [],
      "enabled": [
        "rcres",
        "rcterm",
        "rcbare",
        "rcroot",
      ],
      "fixed": [
        "<node1>",
      ],
      "manifests": [
        [
          "rcres",
          "resumable",
          "per-instance",
          [
            "start",
            "stop",
          ],
        ],
        [
          "rcterm",
          "terminal",
          "per-instance",
          [
            "stop",
          ],
        ],
        [
          "rcbare",
          "resumable",
          "fixed",
          [],
        ],
        [
          "rcroot",
          "terminal",
          "per-instance",
          [
            "stop",
          ],
        ],
      ],
    }
  `);
});
