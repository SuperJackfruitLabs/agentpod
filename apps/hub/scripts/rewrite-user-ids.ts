/**
 * Rewrite every hub column that holds a Better Auth user id to the human's prn_ id — or back.
 *
 * DRY RUN IS THE DEFAULT. `DATABASE_URL=… bun run scripts/rewrite-user-ids.ts` prints, per
 * column, how many rows it would rewrite, how many are already rewritten, and every value it
 * cannot map. Only `--apply` changes anything, in ONE transaction that either completes or leaves
 * the database as it was. See docs/OPERATING.md "Cutover: rewriting user ids" for when to run it.
 *
 * Never a migration (plan decision D1): the hub applies migrations on boot, and this would then
 * rewrite production while every session still carries a Better Auth id. Reversible (D2):
 * `--reverse` maps prn_ ids back and re-adds the user FKs NOT VALID.
 *
 * The inventory below was enumerated from pg_constraint and information_schema on a freshly
 * migrated database (migrations through 0094), and tests/integration/rewrite-user-ids.test.ts
 * fails if a migration adds an FK to "user", or a `*user_id` / `*_by` column, that is not listed
 * here.
 */
import postgres, { type Sql, type TransactionSql } from "postgres";

export interface UserIdColumn {
  table: string;
  column: string;
  fk: string | null;
  onDelete: "CASCADE" | "SET NULL" | null;
}

export const USER_ID_COLUMNS: readonly UserIdColumn[] = [
  { table: "admin_audit_log", column: "admin_user_id", fk: "admin_audit_log_admin_user_id_user_id_fk", onDelete: "SET NULL" },
  { table: "admin_audit_log", column: "target_user_id", fk: "admin_audit_log_target_user_id_user_id_fk", onDelete: "SET NULL" },
  { table: "agent_tasks", column: "user_id", fk: "agent_tasks_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "bridge_agents", column: "created_by", fk: "bridge_agents_created_by_user_id_fk", onDelete: "SET NULL" },
  { table: "cloudflare_sandboxes", column: "user_id", fk: "cloudflare_sandboxes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "enrollment_tokens", column: "user_id", fk: "enrollment_tokens_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "matrix_missions", column: "user_id", fk: "matrix_missions_user_id_fkey", onDelete: "CASCADE" },
  { table: "nodes", column: "user_id", fk: "nodes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "provisioned_runtimes", column: "user_id", fk: "provisioned_runtimes_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_artifacts", column: "user_id", fk: "skill_artifacts_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_operations", column: "user_id", fk: "skill_operations_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "skill_release_cohorts", column: "user_id", fk: "skill_release_cohorts_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "station_setups", column: "user_id", fk: "station_setups_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "station_speech", column: "updated_by", fk: "station_speech_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "station_transcription", column: "updated_by", fk: "station_transcription_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "stations", column: "user_id", fk: "stations_user_id_user_id_fk", onDelete: "CASCADE" },
  { table: "system_settings", column: "updated_by", fk: "system_settings_updated_by_user_id_fk", onDelete: "SET NULL" },
  { table: "trusted_skill_releases", column: "user_id", fk: "trusted_skill_releases_user_id_user_id_fk", onDelete: "CASCADE" },
  // No foreign key, same values (checked against their writers):
  { table: "acp_sessions", column: "user_id", fk: null, onDelete: null },
  { table: "station_audit", column: "user_id", fk: null, onDelete: null },
  { table: "trusted_skill_release_artifacts", column: "user_id", fk: null, onDelete: null },
  { table: "declared_harness_config", column: "declared_by", fk: null, onDelete: null },
  { table: "harness_config_opt_out", column: "opted_out_by", fk: null, onDelete: null },
];

/** Columns that look like user references and are deliberately left alone, with why. */
export const NOT_REWRITTEN: readonly string[] = [
  "account.user_id", // Better Auth; dropped after the rollback window
  "session.user_id", // Better Auth; dropped after the rollback window
  "session.impersonated_by", // Better Auth; dropped after the rollback window
  "device_credentials.user_id", // the hub's own credential table; dropped after the rollback window
  "oauth_codes.user_id", // 60-second auth rows, no FK; dropped after the rollback window
  "live_activity_tokens.user_id", // a Matrix id, not a user id
  "legacy_user_principals.user_id", // the map this script writes: it must keep the OLD id
  "hub_operators.created_by", // free text naming who seated the operator (this script writes its own name)
];

/** Composite (…, tenant_id, user_id) FKs between product tables; NOT DEFERRABLE, so dropped and re-created. */
export const OWNER_FKS: readonly string[] = [
  "skill_operations_artifact_owner_fk",
  "skill_operations_station_owner_fk",
  "skill_release_cohorts_release_owner_fk",
  "station_setups_owner_fk",
  "trusted_skill_release_artifacts_artifact_owner_fk",
  "trusted_skill_release_artifacts_release_owner_fk",
];

// Literal rather than imported from src/db/schema: the script must not pull in the hub's
// connection module (which falls back to a default DATABASE_URL) or its config.
const BOOTSTRAP_TENANT = "fleet_00000000000000000000";
const BOOTSTRAP_ORG = "org_00000000000000000000";
const PRN = /^prn_[0-9a-f]{20}$/;
const SEEDED_BY = "rewrite-user-ids";

export type Direction = "forward" | "reverse";
export interface RewriteOptions {
  direction: Direction;
  /** Operator-supplied `--map from=to` entries; they override what `principal_identities` says. */
  extra?: Record<string, string>;
  /** The org the bootstrap tenant must already be mapped to (default `org_00000000000000000000`). */
  org?: string;
}
export interface RewritePlan {
  direction: Direction;
  counts: Array<{ table: string; column: string; rows: number; toRewrite: number; alreadyTarget: number; unmapped: number }>;
  unmapped: Array<{ table: string; column: string; value: string; rows: number }>;
  collisions: Array<{ principalId: string; userIds: string[] }>;
  operators: string[];
  tenantMapping: "ok" | "missing" | "conflict";
}

export class RewriteRefused extends Error {
  constructor(
    readonly plan: RewritePlan,
    reason: string,
  ) {
    super(`refusing to apply: ${reason}`);
    this.name = "RewriteRefused";
  }
}

type Tx = TransactionSql;
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;

/** old value → new value for this direction: principal_identities' better-auth rows, then `extra` on top. */
async function mapping(tx: Tx, direction: Direction, extra: Record<string, string>): Promise<Map<string, string>> {
  const rows = await tx<{ user_id: string; principal_id: string }[]>`
    SELECT pi.external_id AS user_id, pi.principal_id
    FROM principal_identities pi JOIN principals p ON p.id = pi.principal_id
    WHERE pi.system = 'better-auth' AND p.kind = 'human'`;
  const m = new Map<string, string>();
  for (const r of rows) {
    if (direction === "forward") m.set(r.user_id, r.principal_id);
    else m.set(r.principal_id, r.user_id);
  }
  for (const [from, to] of Object.entries(extra)) m.set(from, to);
  return m;
}

function checkExtra(opts: RewriteOptions): void {
  if (opts.direction !== "forward") return;
  for (const [from, to] of Object.entries(opts.extra ?? {})) {
    if (!PRN.test(to)) throw new Error(`--map ${from}=${to}: a forward mapping must name a prn_ id`);
  }
}

async function planIn(tx: Tx, opts: RewriteOptions): Promise<RewritePlan> {
  checkExtra(opts);
  const map = await mapping(tx, opts.direction, opts.extra ?? {});
  const isTarget = (v: string) => (opts.direction === "forward" ? PRN.test(v) : !PRN.test(v));
  const counts: RewritePlan["counts"] = [];
  const unmapped: RewritePlan["unmapped"] = [];

  for (const c of USER_ID_COLUMNS) {
    const groups = await tx.unsafe<{ v: string; n: number }[]>(
      `SELECT ${q(c.column)} AS v, count(*)::int AS n FROM ${q(c.table)} WHERE ${q(c.column)} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    );
    const row = { table: c.table, column: c.column, rows: 0, toRewrite: 0, alreadyTarget: 0, unmapped: 0 };
    for (const g of groups) {
      row.rows += g.n;
      if (map.has(g.v)) row.toRewrite += g.n;
      else if (isTarget(g.v)) row.alreadyTarget += g.n;
      else {
        row.unmapped += g.n;
        unmapped.push({ table: c.table, column: c.column, value: g.v, rows: g.n });
      }
    }
    counts.push(row);
  }

  // The schema's unique (principal_id, system) index forbids this today; checked anyway because a
  // principal with two Better Auth ids would make --reverse pick one of them silently.
  const collisions = (
    await tx<{ principal_id: string; user_ids: string[] }[]>`
      SELECT principal_id, array_agg(external_id ORDER BY external_id) AS user_ids
      FROM principal_identities WHERE system = 'better-auth'
      GROUP BY principal_id HAVING count(*) > 1 ORDER BY 1`
  ).map((r) => ({ principalId: r.principal_id, userIds: r.user_ids }));

  // Operators: every admin's principal. An admin with no principal is unmapped, not skipped —
  // skipping would apply cleanly and leave the hub with no operator under the plane.
  const operators: string[] = [];
  if (opts.direction === "forward") {
    const admins = await tx<{ id: string }[]>`SELECT id FROM "user" WHERE role = 'admin' ORDER BY id`;
    for (const a of admins) {
      const p = map.get(a.id);
      if (p) operators.push(p);
      else unmapped.push({ table: "user", column: "id (role = admin)", value: a.id, rows: 1 });
    }
    operators.sort();
  }

  const org = opts.org ?? BOOTSTRAP_ORG;
  const [t] = await tx<{ external_source: string | null; external_id: string | null }[]>`
    SELECT external_source, external_id FROM tenants WHERE id = ${BOOTSTRAP_TENANT}`;
  const tenantMapping: RewritePlan["tenantMapping"] =
    !t || t.external_source === null || t.external_id === null
      ? "missing"
      : t.external_source === "org-plane" && t.external_id === org
        ? "ok"
        : "conflict";

  return { direction: opts.direction, counts, unmapped, collisions, operators: [...new Set(operators)], tenantMapping };
}

/** Why `--apply` would refuse this plan, or null when it would run. */
export function refusalOf(plan: RewritePlan): string | null {
  if (plan.unmapped.length > 0) return `${plan.unmapped.length} value(s) have no mapping; pass --map <value>=<id>`;
  if (plan.collisions.length > 0) return "a principal has more than one Better Auth identity";
  if (plan.direction === "forward" && plan.tenantMapping !== "ok") return `bootstrap tenant mapping is ${plan.tenantMapping}`;
  return null;
}

/** Reads only, from one consistent snapshot. */
export async function planRewrite(sql: Sql, opts: RewriteOptions): Promise<RewritePlan> {
  return (await sql.begin("isolation level repeatable read read only", (tx) => planIn(tx, opts))) as RewritePlan;
}

/**
 * Plans and applies in ONE transaction; throws `RewriteRefused` (carrying the plan) before
 * changing anything if a value is unmapped, a principal collides, or (forward) the bootstrap
 * tenant is not mapped to the org.
 */
export async function applyRewrite(sql: Sql, opts: RewriteOptions): Promise<RewritePlan> {
  return (await sql.begin(async (tx) => {
    // Stop the hub first: the script must never queue behind (or block) a live hub's locks.
    await tx`SET LOCAL lock_timeout = '10s'`;
    const plan = await planIn(tx, opts);
    const refusal = refusalOf(plan);
    if (refusal) throw new RewriteRefused(plan, refusal);

    // The composite owner FKs are NOT DEFERRABLE: rewriting `stations.user_id` breaks every
    // (station_id, tenant_id, user_id) reference to it until the referencing table is rewritten
    // too, one statement later. Capture their exact definitions and put them back afterwards.
    const owners = await tx<{ tbl: string; conname: string; def: string }[]>`
      SELECT conrelid::regclass::text AS tbl, conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE contype = 'f' AND conname = ANY(${OWNER_FKS as string[]})
      ORDER BY conname`;
    for (const o of owners) await tx.unsafe(`ALTER TABLE ${o.tbl} DROP CONSTRAINT ${q(o.conname)}`);

    if (opts.direction === "forward") {
      for (const c of USER_ID_COLUMNS) if (c.fk) await tx.unsafe(`ALTER TABLE ${q(c.table)} DROP CONSTRAINT IF EXISTS ${q(c.fk)}`);
    }

    const map = await mapping(tx, opts.direction, opts.extra ?? {});
    await tx`CREATE TEMP TABLE _uid_map (src text PRIMARY KEY, dst text NOT NULL) ON COMMIT DROP`;
    const pairs = [...map.entries()].map(([src, dst]) => ({ src, dst }));
    for (let i = 0; i < pairs.length; i += 1000) {
      await tx`INSERT INTO _uid_map ${tx(pairs.slice(i, i + 1000), "src", "dst")}`;
    }
    for (const c of USER_ID_COLUMNS) {
      await tx.unsafe(
        `UPDATE ${q(c.table)} t SET ${q(c.column)} = m.dst FROM _uid_map m WHERE t.${q(c.column)} = m.src AND m.src <> m.dst`,
      );
    }

    for (const o of owners) await tx.unsafe(`ALTER TABLE ${o.tbl} ADD CONSTRAINT ${q(o.conname)} ${o.def}`);

    if (opts.direction === "forward") {
      await tx`
        INSERT INTO legacy_user_principals (user_id, principal_id)
        SELECT pi.external_id, pi.principal_id FROM principal_identities pi
        JOIN principals p ON p.id = pi.principal_id
        WHERE pi.system = 'better-auth' AND p.kind = 'human'
        ON CONFLICT (user_id) DO NOTHING`;
      for (const id of plan.operators) {
        await tx`INSERT INTO hub_operators (principal_id, created_by) VALUES (${id}, ${SEEDED_BY}) ON CONFLICT DO NOTHING`;
      }
    } else {
      // NOT VALID: rows a plane-only human wrote during the window (kept with --map prn_x=prn_x)
      // must not block a rollback. New writes are still checked.
      const present = new Set(
        (await tx<{ conname: string }[]>`
          SELECT conname FROM pg_constraint
          WHERE conname = ANY(${USER_ID_COLUMNS.flatMap((c) => (c.fk ? [c.fk] : []))})`).map((r) => r.conname),
      );
      for (const c of USER_ID_COLUMNS) {
        if (!c.fk || present.has(c.fk)) continue;
        await tx.unsafe(
          `ALTER TABLE ${q(c.table)} ADD CONSTRAINT ${q(c.fk)} FOREIGN KEY (${q(c.column)}) REFERENCES "user"(id) ON DELETE ${c.onDelete} NOT VALID`,
        );
      }
    }
    return plan;
  })) as RewritePlan;
}

function printPlan(plan: RewritePlan): void {
  console.log(`direction: ${plan.direction}`);
  console.table(plan.counts);
  if (plan.direction === "forward") {
    console.log(`operators to seed: ${plan.operators.join(", ") || "(none)"}`);
    console.log(`bootstrap tenant → org mapping: ${plan.tenantMapping}`);
  }
  if (plan.collisions.length) console.log("principals with several Better Auth ids:", plan.collisions);
  if (plan.unmapped.length) {
    console.log("UNMAPPED — pass --map <value>=<id> for each, or the apply refuses:");
    console.table(plan.unmapped);
  }
}

const USAGE =
  "usage: DATABASE_URL=… bun run scripts/rewrite-user-ids.ts [--apply] [--reverse] [--map <from>=<to> …] [--org org_…] [--json]";

function parseArgs(args: string[]): { apply: boolean; json: boolean; opts: RewriteOptions } {
  let apply = false;
  let json = false;
  let direction: Direction = "forward";
  let org: string | undefined;
  const extra: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--apply") apply = true;
    else if (a === "--reverse") direction = "reverse";
    else if (a === "--json") json = true;
    else if (a === "--org") {
      org = args[++i];
      if (!org) throw new Error("--org takes an org_ id");
    } else if (a === "--map") {
      const v = args[++i] ?? "";
      const eq = v.indexOf("=");
      const from = v.slice(0, eq);
      const to = v.slice(eq + 1);
      if (eq < 1 || !to) throw new Error("--map takes <from>=<to>");
      extra[from] = to;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return { apply, json, opts: { direction, extra, org } };
}

if (import.meta.main) {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must name the hub database explicitly");
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(1);
  }
  const { apply, json, opts } = parsed;
  const url = new URL(process.env.DATABASE_URL!);
  console.error(`database: ${url.hostname}:${url.port || "5432"}${url.pathname} (${apply ? "APPLY" : "dry run"}, ${opts.direction})`);
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  try {
    const plan = apply ? await applyRewrite(sql, opts) : await planRewrite(sql, opts);
    if (json) console.log(JSON.stringify(plan, null, 2));
    else printPlan(plan);
    const refusal = refusalOf(plan);
    if (apply) console.error("APPLIED.");
    else if (refusal) console.error(`Dry run — nothing changed. --apply would refuse: ${refusal}.`);
    else console.error("Dry run — nothing changed. Re-run with --apply.");
    process.exitCode = refusal ? 2 : 0;
  } catch (e) {
    if (e instanceof RewriteRefused) {
      if (json) console.log(JSON.stringify(e.plan, null, 2));
      else printPlan(e.plan);
      console.error(`${e.message}. Nothing changed.`);
      process.exitCode = 2;
    } else {
      console.error(e);
      process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}
