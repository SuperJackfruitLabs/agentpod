# Declared Harness Configuration 3a — the opt-out surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can exempt a station, or every station on a node, from a declared harness setting — and exempt one station back in against a node-wide exemption — through the API and the `fleet` CLI.

**Architecture:** The hub already honours an opt-out everywhere it matters: `planFor` refuses, `applyFor` refuses, `compare()` reports `opted-out`. What is missing is any way to create one — `optOut`/`clearOptOut` are called only from tests. This plan adds the two levels the spec decides (station and node, station winning), the routes, the CLI verbs, and the precedence resolution that makes "station beats node" mean something. It also clears two Plan 2 residuals that live in the same files.

**Tech Stack:** Bun + Hono + Drizzle/Postgres (hub), Go `flag` (fleet CLI), zod (contract).

**Spec:** `docs/superpowers/specs/2026-10-05-declared-harness-config-phase-3-design.md` (Phase 3 delta), and its parent `docs/superpowers/specs/2026-10-04-declared-harness-config-design.md`.

---

## Global Constraints

- **D6 (parent spec)** — an explicit operator opt-out wins; declared state never overrides it.
- **D9 (Phase 3)** — an opt-out is settable at **station and node** level, and **station beats node**. Fleet level is excluded: `fleet config unset` already means that.
- **The register is keyed on the station KEY, not the station row id**, so an opt-out survives unadopt and re-adopt.
- **`compare()` stays a pure function of its arguments.** It queries nothing. Fetch in the caller.
- **Postgres treats NULL as distinct from NULL.** A unique constraint whose columns can be null does not prevent duplicates. This cost a fix round in Plan 1 and it is the central trap of Task 1 here.
- **`tenants.id` is CHECK-constrained to `fleet_<20 hex chars>`.** A fixture id like `tnt_test` fails at insert.
- **`bun run typecheck` is KNOWN RED at exactly 15 errors**, held by `tests/unit/typecheck-baseline.test.ts`. Do not fix those in passing; do not let the count rise.
- **No hub-side `config.manage` pre-check.** Ruled on in Plan 2: the node is the authority on what it can manage and already refuses by name.
- **No workspace-local host names or agent names** in code, tests, docs or help text. The product word is *workspace*.
- **Every predicate test is revert-proofed.** Seven tests across Plans 1 and 2 turned out unable to fail. For each test guarding a decision here: revert the production change, watch the test fail, restore it, and record that you did.

### Running the suites

```bash
cd packages/contract && bun test
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test > /tmp/t.log 2>&1; echo "EXIT=$?"; grep -E "^ *[0-9]+ (pass|fail|skip)" /tmp/t.log
cd apps/node-agent && go test -race -count=1 ./...
```

**Never pipe a long test run through `tail` or `head`** — write it to a file and read the file. A loud migration failure once looked like a 30-minute hang here because a pipe swallowed its output. **If you abort a run partway, reset the test database before trusting the next one** — a truncated run skips every per-file `afterAll`, and the leftover rows produce dozens of failures in unrelated files:

```bash
docker exec agentpod-test-postgres psql -U agentpod -d postgres -c 'DROP DATABASE IF EXISTS agentpod WITH (FORCE);' -c 'CREATE DATABASE agentpod OWNER agentpod;'
```

Baseline to match or beat: contract 406 / 0 fail, hub 3008 pass / 12 skip / 0 fail, node 29 packages ok. Known intermittent and **not yours** — two in `src/routes/evidence.test.ts`, one in `src/services/oauth-codes.test.ts` ("an expired code returns null"), and `TestOpenCodeLifecycle_Start_RemovesSentinelAndSpawnsServeInWorkspace`. All are in files byte-identical to `origin/main`.

---

## Ruling made while writing this plan

**R1 — the register row carries a boolean, not merely existence.**

D9 says "station beats node". With a presence-only register that sentence cannot be implemented: a row either exists or does not, so the only possible behaviour is union — exempted at *either* level means exempted — and there is no way to say "every station on this node except that one". So a row carries `optedOut: boolean`:

| intent | row |
|---|---|
| exempt this station | station row, `optedOut = true` |
| exempt every station on this node | node row, `optedOut = true` |
| this one station is *not* exempt, despite the node | station row, `optedOut = false` |
| forget what I said about this station | no station row (deleted) |

Resolution is most-specific-first, exactly as declarations resolve: station row if present, else node row, else not opted out. A deleted row is absence, which falls through to the next level — distinct from a `false` row, which stops the search.

*Cost if wrong:* the CLI carries one verb more than strictly needed (`opt-in`). The alternative — union semantics — would contradict D9's own words and leave no way to exempt a single station from a node-wide rule.

---

## File Structure

**Contract**
- Modify: `packages/contract/src/harness-config.ts` — `ConfigOptOut`, and `OptOutLevel`
- Test: `packages/contract/test/harness-config.test.ts`

**Hub**
- Modify: `apps/hub/src/db/schema/harness-config-ops.ts` — `nodeId`, nullable `stationKey`, `optedOut`, the level CHECK; and the FK on `applied_harness_config.station_id`
- Create: `apps/hub/src/db/drizzle-migrations/00NN_config_opt_out_levels.sql` (number at generate time)
- Modify: `apps/hub/src/services/harness-config.ts` — `setOptOut`, `clearOptOut`, `resolveOptOuts`, `listOptOuts`; `getOptOuts` removed
- Modify: `apps/hub/src/services/harness-config-apply.ts` — the two call sites that resolve opt-outs
- Modify: `apps/hub/src/routes/harness-config.ts` — the opt-out routes, and `plan`'s setting selector
- Test: `apps/hub/tests/integration/harness-config-optout-levels.test.ts` (create), `apps/hub/tests/integration/harness-config-optout-write.test.ts` (exists), `apps/hub/tests/unit/harness-config-compare.test.ts` (exists)

**CLI**
- Modify: `apps/node-agent/cmd/agentpod-fleet/config.go` — `opt-out`, `opt-in`, `--clear`, and `plan --setting`
- Test: `apps/node-agent/cmd/agentpod-fleet/config_test.go`

**Docs**
- Modify: `docs-site/src/content/docs/use/config.md`

---

## Task 1: Two levels, and the NULL trap

**Files:**
- Modify: `apps/hub/src/db/schema/harness-config-ops.ts`
- Create: `apps/hub/src/db/drizzle-migrations/00NN_config_opt_out_levels.sql`
- Test: `apps/hub/tests/integration/harness-config-optout-levels.test.ts`

**Interfaces:**
- Consumes: `harnessConfigOptOut` and `appliedHarnessConfig` as Plan 2 shipped them
- Produces, consumed by Tasks 2–5: a table where exactly one of `station_key` / `node_id` is set, `opted_out` is a boolean, and duplicates are impossible at **both** levels

**All three config tables are empty in production** (verified 2026-10-05), so this migration needs no data migration, no backfill and no orphan cleanup. Say so in the commit message — it is why an otherwise awkward `ALTER` is safe here.

**The trap, stated plainly.** The shipped table has `stationKey NOT NULL` and `unique(tenantId, stationKey, settingId)`. Making `stationKey` nullable to represent a node-level row **silently destroys that constraint's usefulness**: Postgres never conflicts on NULL, so two node-level rows for the same `(tenant, node, setting)` both insert. Plan 1 hit exactly this on `declared_harness_config` and needed a partial index. Do not use a plain unique constraint here.

- [ ] **Step 1: Write the failing tests**

In `apps/hub/tests/integration/harness-config-optout-levels.test.ts`, with a `fleet_<20 hex>` tenant and per-file row cleanup in `afterAll`:

```ts
describe("the opt-out register has two levels and no duplicates", () => {
  test("a station row and a node row for the same setting coexist", async () => {
    // Both insert; they are different levels, not a conflict.
  });

  test("two station rows for the same (tenant, station, setting) cannot both exist", async () => {
    // The second must conflict. This is the ordinary case and the shipped
    // constraint already covered it — assert it still does after the ALTER.
  });

  test("two NODE rows for the same (tenant, node, setting) cannot both exist", async () => {
    // THE REGRESSION THIS TASK EXISTS TO PREVENT. With station_key NULL on
    // both rows, a plain unique constraint does not conflict and both insert.
    // Must throw.
  });

  test("a row with neither station nor node is refused", async () => {
    // The level CHECK. There is no fleet level (D9).
  });

  test("a row with BOTH station and node is refused", async () => {
    // Also the level CHECK: a row names exactly one level.
  });

  test("deleting a station row leaves the node row untouched", async () => {
    // Clearing one level must not clear the other.
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/integration/harness-config-optout-levels.test.ts
```
Expected: FAIL — `node_id` does not exist.

- [ ] **Step 3: Change the schema**

```ts
/**
 * An operator's explicit exemption. Exactly one of `stationKey` / `nodeId` is
 * set — the level CHECK below makes any other row unrepresentable, and there
 * is deliberately no fleet level (D9: `fleet config unset` already says that).
 *
 * `optedOut` is a boolean rather than the row's mere existence because D9 says
 * station beats node, and that is only expressible if a station row can say
 * "NOT exempt" against a node row that says "exempt". See the plan's R1.
 *
 * Keyed on the station KEY, not the station row id, so an exemption survives
 * unadopt and re-adopt.
 */
export const harnessConfigOptOut = pgTable(
  "harness_config_opt_out",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    stationKey: text("station_key"),
    nodeId: text("node_id"),
    settingId: text("setting_id").notNull(),
    optedOut: boolean("opted_out").notNull().default(true),
    reason: text("reason"),
    optedOutBy: text("opted_out_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    check(
      "cfg_opt_out_one_level",
      sql`(${t.stationKey} IS NULL) <> (${t.nodeId} IS NULL)`,
    ),
  ],
);
```

Then generate the migration and **hand-add both partial unique indexes**, because drizzle will not infer them:

```bash
cd apps/hub && bun run db:generate
```

Append to the generated file:

```sql
--> statement-breakpoint
-- Postgres never conflicts on NULL, so one index per level, each scoped to
-- the level it covers. A single unique constraint over both nullable columns
-- would let duplicate node-level rows insert — the Plan 1 defect, repeated.
CREATE UNIQUE INDEX "cfg_opt_out_station" ON "harness_config_opt_out"
  ("tenant_id", "station_key", "setting_id") WHERE "node_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "cfg_opt_out_node" ON "harness_config_opt_out"
  ("tenant_id", "node_id", "setting_id") WHERE "station_key" IS NULL;
```

Drop the old `cfg_opt_out_key_setting` constraint in the same migration — it is the one the nullable column defeats.

- [ ] **Step 4: Add the FK on `applied_harness_config.station_id` (Plan 2 residual)**

In the same migration, since both tables are empty and a second migration would mean a second 6,600-line snapshot:

```ts
stationId: text("station_id").notNull().references(() => stations.id, { onDelete: "cascade" }),
```

A cascade is right: an applied-write record for a station that no longer exists is garbage, and keeping it could let a re-adopted station inherit a stale "written" record and so a wrong `awaiting-restart`.

Add a test: deleting a station removes its `applied_harness_config` rows.

- [ ] **Step 5: Confirm the generated migration is clean**

```bash
cd apps/hub && bun run db:generate
```
Expected: "No schema changes, nothing to migrate". If instead it re-emits DDL for objects already live, that is snapshot drift from hand-written migrations on main — strip the re-emitted objects, keep only yours, and say so in the commit message.

- [ ] **Step 6: Run the file, then the whole hub suite, and commit**

- [ ] **Step 7: Mutation-test the node-level index**

Drop `cfg_opt_out_node` from the migration, re-run the test DB from scratch, and confirm "two NODE rows … cannot both exist" FAILS. Restore it. A uniqueness test that passes without its index is testing nothing.

---

## Task 2: Resolution, most-specific-first

**Files:**
- Modify: `apps/hub/src/services/harness-config.ts`
- Test: `apps/hub/tests/unit/harness-config-compare.test.ts`, `apps/hub/tests/integration/harness-config-optout-levels.test.ts`

**Interfaces:**
- Consumes: Task 1's table
- Produces, consumed by Tasks 3–5:
  ```ts
  export type OptOutLevel = "station" | "node";
  export async function setOptOut(input: {
    tenantId: string; settingId: string; optedOut: boolean;
    stationKey?: string; nodeId?: string; reason?: string; optedOutBy: string;
  }): Promise<void>;
  export async function clearOptOut(input: {
    tenantId: string; settingId: string; stationKey?: string; nodeId?: string;
  }): Promise<{ cleared: boolean }>;
  /** settingIds this station is exempt from, station beating node. */
  export async function resolveOptOuts(
    tenantId: string, stationKey: string, nodeId: string
  ): Promise<Set<string>>;
  export async function listOptOuts(
    tenantId: string, filter?: { stationKey?: string; nodeId?: string }
  ): Promise<HarnessConfigOptOutRow[]>;
  ```
  `getOptOuts` is **removed**, not kept as an alias — a second way to ask this question is how the two call sites drift apart.

- [ ] **Step 1: Write the failing tests**

```
- a station row optedOut=true exempts the setting
- a node row optedOut=true exempts every station on that node
- a station row optedOut=FALSE overrides a node row optedOut=true  ← R1's whole point
- no row at either level means not exempt
- deleting the station row falls back to the node row (absence ≠ false)
- resolveOptOuts returns only ids for THIS station and THIS node, never another tenant's
- setOptOut twice for the same level updates rather than duplicating
- clearOptOut reports cleared:false when there was nothing to clear
```

The third and fifth are load-bearing: the first proves precedence exists, the second proves a deleted row is absence rather than a `false`.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement**

`setOptOut` upserts against the level's partial index (`onConflictDoUpdate` with the matching `target` and a `targetWhere`, or a transactional delete-then-insert over a shared level predicate as `declare()` does — follow whichever `declare()` uses, so there is one idiom in the file). `resolveOptOuts` reads both levels in one query and resolves in code: a station row wins outright; otherwise the node row decides; otherwise not exempt.

Use `tenantScope()` as the rest of the file does. Do not hand-roll a tenant filter.

- [ ] **Step 4: Mutation-test the precedence**

Make `resolveOptOuts` prefer the node row over the station row. "a station row optedOut=FALSE overrides a node row" MUST fail. Restore.

- [ ] **Step 5: Run the hub suite and commit**

---

## Task 3: The two callers resolve the same way

**Files:**
- Modify: `apps/hub/src/routes/harness-config.ts` (`observeStation`), `apps/hub/src/services/harness-config-apply.ts` (`reconcileStation`, `planFor`, `applyFor`)
- Test: `apps/hub/tests/integration/harness-config-optout-write.test.ts` (exists)

**Interfaces:**
- Consumes: `resolveOptOuts` (Task 2)
- Produces: every path that honoured a station-level opt-out now honours a node-level one too

Four call sites consulted `getOptOuts(tenantId, stationKey)`. Each needs the station's `nodeId` as well. `observeStation` already has the station row; `planFor`/`applyFor`/`reconcileStation` take a station. **Do not** fetch the node separately where the station row already carries `nodeId`.

- [ ] **Step 1: Write the failing tests**

```
- GET /api/stations/:id/config reports opted-out for a NODE-level exemption
- POST .../config/plan refuses a node-level exempted setting, naming it
- POST .../config/apply refuses it too, even when the plan predates the exemption
- adopt-time reconcile skips a node-level exempted setting
- a station row optedOut=false lets plan/apply proceed despite the node row
```

That last one is the end-to-end proof of R1 and is the one to write first.

- [ ] **Step 2: Run them and watch them fail** — they should fail by *succeeding* where they must refuse.

- [ ] **Step 3: Replace all four call sites**

- [ ] **Step 4: Run the hub suite and commit**

---

## Task 4: Routes

**Files:**
- Modify: `apps/hub/src/routes/harness-config.ts`, `packages/contract/src/harness-config.ts`
- Test: `apps/hub/tests/integration/harness-config-optout-levels.test.ts`

**Interfaces:**
- Produces, consumed by Task 5:
  - `PUT    /api/fleet/config/opt-out` — body `{settingId, optedOut, stationKey?|nodeId?, reason?}`
  - `DELETE /api/fleet/config/opt-out` — body `{settingId, stationKey?|nodeId?}`
  - `GET    /api/fleet/config/opt-out` — optional `?stationKey=` / `?nodeId=`

Authorise exactly as the sibling declared-state routes do: `AuthUser` off `c.get("user")`, the same tenant resolution, the same `nonHumanRefusal`. Validate the setting id against the live registry (`fetchRegistry`) before writing, so an exemption cannot be recorded for a setting no harness has — the same bound D1 draws for declarations.

Add the contract types, mirroring the shipped `DeclaredSetting` shape and its one-level refine:

```ts
/** Exactly one of stationKey / nodeId. There is no fleet level (D9). */
export const ConfigOptOut = z.object({
  settingId: z.string(),
  stationKey: z.string().nullable().optional(),
  nodeId: z.string().nullable().optional(),
  optedOut: z.boolean(),
  reason: z.string().optional(),
}).refine(
  (v) => (v.stationKey == null) !== (v.nodeId == null),
  { message: "an opt-out names exactly one of stationKey or nodeId" },
);
```

- [ ] **Step 1: Write the failing tests** — each verb; a body naming both levels is 400; a body naming neither is 400; an unregistered setting id is refused before any write; another tenant's station is invisible; a non-human principal is refused.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement the three handlers and the contract type**
- [ ] **Step 4: Run contract + hub suites and commit**

---

## Task 5: `fleet config opt-out | opt-in`, and `plan --setting`

**Files:**
- Modify: `apps/node-agent/cmd/agentpod-fleet/config.go`
- Test: `apps/node-agent/cmd/agentpod-fleet/config_test.go`

**Interfaces:**
- Consumes: Task 4's routes

Extend `configUsage` — currently nine verbs aligned at one column (keep that alignment):

```
  fleet config opt-out SETTING_ID [--station ID | --node ID] [--reason TEXT]
  fleet config opt-in  SETTING_ID [--station ID | --node ID]
  fleet config opt-out SETTING_ID [--station ID | --node ID] --clear
  fleet config opt-out                                          what is exempt, and where
  fleet config plan    --station ID [--setting SETTING_ID]      narrow the plan to one setting
```

Three sentences the help must carry, because each is a thing an operator would otherwise have to discover:
1. **`opt-out` stops this system writing a setting; it does not change what is already in the file.** An exemption is not an undo.
2. **`opt-in` is not the same as `--clear`.** `opt-in` records "this station is *not* exempt", which overrides a node-level exemption; `--clear` forgets the row entirely and falls back to the node level.
3. **A station-level row always beats a node-level one.**

- [ ] **Step 1: Write the failing tests** — flags parse; `opt-out`/`opt-in` with both `--station` and `--node` is a usage error issuing no request; with neither is a usage error; `--clear` sends DELETE not PUT; `plan --setting` sends exactly that one id; usage lists every verb.
- [ ] **Step 2: Run them and watch them fail**
- [ ] **Step 3: Implement**, following the existing `flag.NewFlagSet` style in the file exactly.
- [ ] **Step 4: `go test -race -count=1 ./...`, `gofmt -l` clean, commit**

---

## Task 6: The docs page says what is now true

**Files:**
- Modify: `docs-site/src/content/docs/use/config.md`
- Test: `apps/hub/tests/unit/docs-claims.test.ts`

The page is live at https://docs.agentpod.dev/use/config/. **Check every claim against the code, not against this plan.** This estate has shipped docs that overstated reality more than once, and this session alone caught three.

The page currently describes the opt-out register's existence without any way to use it, because there was none. It must now carry:
- the two levels, and that a station row beats a node row;
- the difference between `opt-in` and `--clear` — a `false` row stops the search, an absent row falls through;
- that an exemption stops this system writing, and does not revert what is already in the file;
- that there is no fleet-level exemption, and why (`unset` says that);
- the worked `fleet config opt-out` / `opt-in` examples.

- [ ] **Step 1: List what the page currently claims about opt-out** — `grep -n "opt" docs-site/src/content/docs/use/config.md`
- [ ] **Step 2: Rewrite those sections**
- [ ] **Step 3: Run `docs-claims.test.ts`.** Its regexes were widened to `[a-z][a-z-]*` in PR #652 because a narrower pattern silently skipped hyphenated commands. `opt-out` and `opt-in` are hyphenated — **verify the test actually sees them**, and if you widen anything, mutation-test the widening.
- [ ] **Step 4: Commit**

---

## Self-review notes

**Spec coverage.** D9 → Tasks 1–5, with R1 making "station beats node" implementable. The Phase 3 residual table assigns the `applied_harness_config` FK and the `plan` setting selector to 3a → Tasks 1 and 5. D6 is what Task 3 extends to the node level. D10's sidecar is **not here** — it is node write-path work and belongs to 3b.

**Type consistency.** `OptOutLevel`, `setOptOut`, `clearOptOut`, `resolveOptOuts`, `listOptOuts` are used with those exact names in Tasks 2–5. `getOptOuts` is removed in Task 2, and Task 3 is the task that removes its last caller — so Task 2 must not land alone on a tree where Task 3's call sites still reference it. If you execute out of order, the compiler will say so.

**The one thing most likely to go wrong** is Task 1's partial indexes. A plain unique constraint over nullable columns looks correct, passes a casual test that only inserts station rows, and silently permits duplicate node-level rows. Task 1 Step 7 exists to prove the index is doing the work.
