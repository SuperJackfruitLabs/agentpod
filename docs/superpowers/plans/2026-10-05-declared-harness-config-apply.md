# Declared Harness Configuration — Apply (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A declared harness setting can be planned, reviewed and written to a station — reconciled at adopt time, reported as drift thereafter — without ever restarting a harness or touching a key outside the plan.

**Architecture:** Plan 1 shipped the read half: a registry in the node, declared state in the hub, and `compare()`. This plan adds the write half behind the same seam. The node gains `PlanConfig`/`ApplyConfig` on the existing optional `ConfigManager` interface, mirroring the proven `internal/hermeslive` plan→digest→apply machinery: a plan is re-derived at apply time and its digest compared, so a document that changed since review is refused rather than re-planned. The hub gains the plan/inspect/apply route trio, an adopt-time reconcile that cannot fail an adoption, and the evidence to make `awaiting-restart` and `opted-out` reachable states instead of documented placeholders.

**Tech Stack:** Go 1.x (node-agent, `gopkg.in/yaml.v3` for parse-to-decide), Bun + Hono + Drizzle/Postgres (hub), zod (contract), Go `flag` (fleet CLI).

**Spec:** `docs/superpowers/specs/2026-10-04-declared-harness-config-design.md`

**Plan 1 (shipped, PR #663):** `docs/superpowers/plans/2026-10-04-declared-harness-config-observe.md`

**Plan 3 (not yet written):** folding in the four existing settings under the byte-identical guarantee (spec §10.9), and the console panel (spec §8).

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **D1 — named settings only.** "An unregistered key is refused by name, never written speculatively." A setting id absent from `ConfigSettings()` is `UNKNOWN_SETTING`.
- **D4 — never restart, and name the state.** "Neither restarts the gateway; that is yours to do." No task in this plan may start, stop or restart a harness process. A written setting that needs a restart reports `awaiting-restart`, never success.
- **D5 — parse to decide, edit as lines to do it.** "re-encoding would reflow an operator's file." Comments, ordering and indentation are the operator's. Never marshal a whole document back out.
- **D6 — an explicit operator opt-out wins.** Declared state does not override it. Such a station reports `opted-out`, not `drifted`.
- **D8 — applying is reviewed, against a plan digest.** "A plan that no longer matches the document is refused rather than re-derived."
- **F1 — the harness rewrites its own config.** Hermes' own `plugins entries` and `_config_version` are never touched.
- **F2 — the harness persists operator decisions into it.** "Allow always" writes `command_allowlist`. Reconciling that key would delete grants an operator made minutes earlier. `additive-only` exists for this.
- **No upstream changes.** Nothing in this plan modifies Hermes, OpenClaw or any other harness, or depends on a change to one.
- **Local names are never product vocabulary.** No workspace-local host or agent names in shipped code, tests, docs or help text. The product word is *workspace*.
- **`CREDENTIAL_PATH` is a hard refusal, not a warning** (spec §9).
- **Every test must fail before its implementation exists, and a widened predicate must be mutation-tested** — "a check that accepts more is exactly the change that can quietly stop checking."

### Refusal codes (spec §9) — the complete set, each distinct

| code | when |
|---|---|
| `UNKNOWN_SETTING` | an id not in the registry (D1) |
| `OUT_OF_SCOPE` | station-scoped declaration for a `user`-scoped setting (D7) |
| `SHAPE_UNEXPECTED` | the document is not the shape the writer knows — `ErrConflict`'s meaning |
| `PLAN_STALE` | the document changed since the plan was reviewed (D8) |
| `OPTED_OUT` | an explicit operator opt-out (D6) |
| `UNREADABLE` | the document could not be parsed; nothing is inferred |
| `CREDENTIAL_PATH` | the target resolves to a credential file (`auth.json`, `.env`) |

---

## Two rulings made while writing this plan

Both are recorded here rather than left for an implementer to guess, and both carry what they cost if wrong.

**R1 — the opt-out register lives in the hub, not in the harness document.**

D6 cites `ErrDisabledByOperator`, which the plugins installer reads from `plugins.disabled` — a key Hermes itself defines. `approvals.*` has no equivalent native opt-out key. The obvious symmetry would be to invent one (`agentpod.config_opt_out`) inside `~/.hermes/config.yaml`, and this plan does **not** do that: by F1 Hermes migrates and rewrites its own config on load (config version 17), so a key Hermes does not know is a key whose survival we do not control, and writing it would be an upstream-shaped change under a constraint that forbids upstream changes.

Instead the opt-out is a hub-side record per `(stationId, settingId)`, set explicitly by an operator. Where a harness *does* have a native opt-out, the descriptor keeps honouring it and reports `opted-out` from the document — that path is preserved exactly, not replaced.

*Cost if wrong:* an opt-out does not survive the station being removed from the hub and re-adopted, where a key in the operator's own file would have. Task 9 mitigates by keeping the register keyed on the stable station key rather than the row id.

**R2 — `awaiting-restart` is decided by gateway pid, not by a timer.**

F4 requires distinguishing "written" from "in effect". `StationHealth` already carries `pid` and `uptimeSec`, and because Hermes multiplexes one gateway across all profiles, that pid is precisely the process that re-reads config. So apply records the gateway's pid and uptime, and `compare()` reports `awaiting-restart` while the current pid is unchanged.

When the pid is unavailable (health degraded, harness stopped), the state stays `awaiting-restart` rather than resolving to `matches`. This follows the spec's own asymmetry argument in §7: claiming a restart is still needed when it is not costs a needless restart, while claiming it is not needed when it is produces the F4 state the spec calls a worse drift.

*Cost if wrong:* a station whose gateway is restarted by something else between apply and the next observation reports `matches` one sweep earlier than it strictly proved. That is the benign direction.

---

## File Structure

**Contract**
- Modify: `packages/contract/src/harness-config.ts` — add `ConfigRefusalCode`, `ConfigPlanEntry`, `ConfigPlan`, `ConfigReceipt`. Existing exports unchanged.
- Test: `packages/contract/test/harness-config.test.ts` (exists — note `test/`, not `src/`, unlike most contract tests)

**Node — the writer**
- Modify: `apps/node-agent/internal/descriptor/yamlscalar.go` — list-valued reads (fixes the `command_allowlist` false-`absent`)
- Create: `apps/node-agent/internal/descriptor/config_plan.go` — `ConfigPlan`/`ConfigReceipt` Go structs, `digestOf`, refusal construction
- Create: `apps/node-agent/internal/descriptor/configedit/edit.go` — the generalized line editor and `sameOutsideKeys`
- Create: `apps/node-agent/internal/descriptor/configedit/edit_test.go`
- Modify: `apps/node-agent/internal/descriptor/config_manage.go` — extend the `ConfigManager` interface
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go` — `PlanConfig`, `ApplyConfig`
- Create: `apps/node-agent/internal/descriptor/hermes_config_plan_test.go`
- Create: `apps/node-agent/internal/descriptor/config_journal.go` — per-station operation journal
- Modify: `apps/node-agent/internal/descriptor/handler.go` — `config.plan`, `config.inspect`, `config.apply` verbs

**Hub**
- Create: `apps/hub/src/db/schema/harness-config-ops.ts` — applied-write records and the opt-out register
- Create: `apps/hub/src/db/drizzle-migrations/00NN_harness_config_ops.sql` (number at generate time; see Task 7 step 1)
- Modify: `apps/hub/src/db/schema/index.ts`, `apps/hub/src/db/tenant-scope.ts` — register both new tables
- Modify: `apps/hub/src/services/harness-config.ts` — `compare()` gains the two states, plus `optOut` / `clearOptOut` (Task 9 only)
- Create: `apps/hub/src/services/harness-config-apply.ts` — plan/inspect/apply orchestration, `recordApplied` (Task 7), and the adopt-time reconcile (Task 8)
- Modify: `apps/hub/src/routes/harness-config.ts` — the plan/inspect/apply trio
- Modify: `apps/hub/src/services/station-registry.ts` — the post-adopt hook
- Test: `apps/hub/tests/unit/harness-config-compare.test.ts` (exists), `apps/hub/tests/integration/harness-config-apply.test.ts` (create), `apps/hub/tests/integration/harness-config-adopt.test.ts` (create)

**CLI**
- Modify: `apps/node-agent/cmd/agentpod-fleet/config.go` — `plan`, `inspect`, `apply`

**Docs**
- Modify: `docs-site/src/content/docs/use/config.md`

---

## Task 1: Determine whether `approvals.*` needs a restart

Spec §7: "The restart column for `approvals.*` is not yet known… The first task of the implementation is to determine it against a live profile." Plan 1 shipped all three entries as `RestartToTakeEffect: true`, labelled unverified. This task either replaces that assumption with evidence or records why it stands.

**Files:**
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go` (only if the finding changes a value)
- Create: `docs/superpowers/notes/2026-10-05-hermes-approvals-restart.md`

**Interfaces:**
- Consumes: `hermesConfigRegistry` from Plan 1
- Produces: a verified `RestartToTakeEffect` per `approvals.*` setting, consumed by Tasks 4, 5 and 9

**This task is read-only by default.** Determining this conclusively would mean changing a value on a live profile and observing a running gateway — which restarts a live agent's gateway, an outward-facing act on someone's workspace. Do **not** do that on your own initiative.

- [ ] **Step 1: Search Hermes' own distributed source and docs for how `approvals` is read**

The question is whether the approvals config is read once at gateway start or per-request. Read, do not run:

```bash
# Hermes is installed on this host; find where approvals config is consumed.
grep -rn "approvals" --include="*.go" --include="*.py" --include="*.ts" \
  "$(dirname "$(command -v hermes 2>/dev/null || echo /nonexistent)")/.." 2>/dev/null | head -30
grep -rn "approvals" ~/.hermes/docs 2>/dev/null | head -20
hermes --help 2>&1 | grep -i "reload\|approval" | head
```

Record exactly what you find, including finding nothing.

- [ ] **Step 2: Check whether Hermes documents a reload boundary that covers it**

The spec notes Hermes documents hot-reload for `model.context_length` and `compression.*`, and a restart for "API keys and tool/skill config". Determine which list, if either, `approvals.*` falls in. A documented sentence is evidence; an absence is not.

- [ ] **Step 3: Write the note**

Create `docs/superpowers/notes/2026-10-05-hermes-approvals-restart.md` stating the finding, the evidence for it, and the resulting value. If the evidence is inconclusive, the note says so in those words and the value stays `true`, citing the spec's asymmetry argument. **Do not write "verified" unless a cited artefact says it.**

- [ ] **Step 4: Apply the finding only if it changes something**

If and only if the evidence shows a setting takes effect without a restart, change that entry's `RestartToTakeEffect` to `false` and update the Plan 1 comment that calls it unverified.

- [ ] **Step 5: Run the node tests and commit**

```bash
cd apps/node-agent && go test -race -count=1 ./...
git add -A && git commit -m "node: what the evidence says about approvals and restarts"
```

**Report in your task report:** whether a live experiment is the only remaining way to settle this. If it is, say so plainly — the controller will raise it rather than run it.

---

## Task 2: The contract types a plan travels as

**Files:**
- Modify: `packages/contract/src/harness-config.ts`
- Test: `packages/contract/test/harness-config.test.ts`

**Interfaces:**
- Consumes: `ConfigScope`, `ConfigPolicy`, `ConfigSetting`, `ConfigValue`, `ConfigObservation` (Plan 1)
- Produces: `ConfigRefusalCode`, `ConfigPlanEntry`, `ConfigPlan`, `ConfigReceipt` — consumed by Tasks 3–10. The Go structs in Task 3 must carry JSON tags matching these field names byte-for-byte.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contract/src/harness-config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ConfigPlan, ConfigReceipt, ConfigRefusalCode } from "./harness-config";

describe("a config plan is reviewable before it is applied", () => {
  const entry = {
    settingId: "hermes.approvals.timeout",
    file: "/home/x/.hermes/profiles/p/config.yaml",
    keyPath: "approvals.timeout",
    policy: "reconcilable" as const,
    current: 300,
    intended: 900,
    action: "modify" as const,
    restartToTakeEffect: true,
  };

  test("a plan carries its digest and the document it was derived from", () => {
    const plan = ConfigPlan.parse({
      schemaVersion: 1,
      operationId: "op_1",
      stationKey: "p",
      entries: [entry],
      beforeSha256: "a".repeat(64),
      diff: "-  timeout: 300\n+  timeout: 900\n",
      diffTruncated: false,
      noOp: false,
      restartRequired: true,
      createdAt: "2026-10-05T00:00:00.000Z",
      planDigest: "b".repeat(64),
    });
    expect(plan.entries[0]?.intended).toBe(900);
    expect(plan.refusal).toBeUndefined();
  });

  test("a refused plan names a code from the registry of refusals, and writes nothing", () => {
    const plan = ConfigPlan.parse({
      schemaVersion: 1, operationId: "op_2", stationKey: "p", entries: [],
      beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: true,
      restartRequired: false, createdAt: "2026-10-05T00:00:00.000Z", planDigest: "c".repeat(64),
      refusal: { code: "CREDENTIAL_PATH", message: "the target resolves to a credential file" },
    });
    expect(plan.refusal?.code).toBe("CREDENTIAL_PATH");
    // A refusal never carries a restart claim.
    expect(plan.restartRequired).toBe(false);
  });

  test("every refusal code in the spec is representable, and nothing else is", () => {
    for (const code of ["UNKNOWN_SETTING", "OUT_OF_SCOPE", "SHAPE_UNEXPECTED",
      "PLAN_STALE", "OPTED_OUT", "UNREADABLE", "CREDENTIAL_PATH"]) {
      expect(ConfigRefusalCode.parse(code)).toBe(code);
    }
    expect(ConfigRefusalCode.safeParse("WHATEVER").success).toBe(false);
  });

  test("a receipt records what was written, per entry, and never claims a restart happened", () => {
    const receipt = ConfigReceipt.parse({
      plan: {
        schemaVersion: 1, operationId: "op_1", stationKey: "p", entries: [entry],
        beforeSha256: "a".repeat(64), diff: "", diffTruncated: false, noOp: false,
        restartRequired: true, createdAt: "2026-10-05T00:00:00.000Z", planDigest: "b".repeat(64),
      },
      phase: "applied",
      updatedAt: "2026-10-05T00:00:01.000Z",
      written: [{ settingId: "hermes.approvals.timeout", action: "modify", wrote: 900 }],
      afterSha256: "d".repeat(64),
    });
    expect(receipt.phase).toBe("applied");
    expect(receipt.written[0]?.wrote).toBe(900);
    expect(receipt).not.toHaveProperty("restarted");
  });

  test("`conflict` is a phase, so a stale plan is an answer rather than a thrown error", () => {
    expect(ConfigReceipt.shape.phase.safeParse("conflict").success).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd packages/contract && bun test src/harness-config.test.ts
```
Expected: FAIL — `ConfigPlan` is not exported.

- [ ] **Step 3: Add the types**

Append to `packages/contract/src/harness-config.ts`:

```ts
/** Every refusal this system can give, each distinct. See spec §9. */
export const ConfigRefusalCode = z.enum([
  "UNKNOWN_SETTING",
  "OUT_OF_SCOPE",
  "SHAPE_UNEXPECTED",
  "PLAN_STALE",
  "OPTED_OUT",
  "UNREADABLE",
  "CREDENTIAL_PATH",
]);
export type ConfigRefusalCode = z.infer<typeof ConfigRefusalCode>;

export const ConfigRefusal = z.object({
  code: ConfigRefusalCode,
  /** A sentence. A refusal that cannot be told from a pass is the failure this area keeps hitting. */
  message: z.string(),
});

/** One setting's intended edit. `current` absent means the key is not in the document. */
export const ConfigPlanEntry = z.object({
  settingId: z.string(),
  /** Absolute path of the document this entry edits. */
  file: z.string(),
  keyPath: z.string(),
  policy: ConfigPolicy,
  current: z.unknown().optional(),
  intended: z.unknown(),
  action: z.enum(["create", "modify", "append", "noop"]),
  restartToTakeEffect: z.boolean(),
});

/**
 * A plan is what review sees. Its digest covers everything in it INCLUDING
 * `beforeSha256`, so a document edited after review yields a different digest
 * and the apply is refused rather than re-derived (D8).
 */
export const ConfigPlan = z.object({
  schemaVersion: z.literal(1),
  operationId: z.string(),
  stationKey: z.string(),
  entries: z.array(ConfigPlanEntry),
  /** SHA-256 of the document as it was when planned. */
  beforeSha256: z.string(),
  diff: z.string(),
  diffTruncated: z.boolean(),
  noOp: z.boolean(),
  refusal: ConfigRefusal.optional(),
  /** True when any entry needs a restart. Nothing here performs one (D4). */
  restartRequired: z.boolean(),
  createdAt: z.string(),
  planDigest: z.string(),
});

export const ConfigWritten = z.object({
  settingId: z.string(),
  action: z.enum(["create", "modify", "append", "noop"]),
  wrote: z.unknown(),
});

/** The journal entry for one apply. There is deliberately no `restarted` field. */
export const ConfigReceipt = z.object({
  plan: ConfigPlan,
  phase: z.enum(["planned", "applying", "applied", "conflict"]),
  updatedAt: z.string(),
  written: z.array(ConfigWritten).default([]),
  afterSha256: z.string().optional(),
  error: z.string().optional(),
});

export type ConfigPlan = z.infer<typeof ConfigPlan>;
export type ConfigReceipt = z.infer<typeof ConfigReceipt>;
export type ConfigPlanEntry = z.infer<typeof ConfigPlanEntry>;
```

- [ ] **Step 4: Run the tests**

```bash
cd packages/contract && bun test
```
Expected: PASS, and the whole contract suite still green.

- [ ] **Step 5: Commit**

```bash
git add packages/contract && git commit -m "contract: the shapes a config plan and its receipt travel as"
```

---

## Task 3: A key-path YAML editor that can see lists

Two jobs, both prerequisites for planning. First, Plan 1's reader refuses list values and therefore reports `command_allowlist` as `absent` — a false negative on the one setting F2 is about. Second, the generalized "nothing else changed" guarantee: `hermeslive`'s `sameOutsideOurKeys` is hardcoded to the plugins keys, and a registry needs it parameterised by the key paths a plan touches.

**Files:**
- Modify: `apps/node-agent/internal/descriptor/yamlscalar.go`
- Create: `apps/node-agent/internal/descriptor/configedit/edit.go`
- Test: `apps/node-agent/internal/descriptor/configedit/edit_test.go`
- Test: `apps/node-agent/internal/descriptor/yamlscalar_test.go` (exists)

**Interfaces:**
- Consumes: `yamlValue`, `yamlScalar` (Plan 1, `yamlscalar.go`)
- Produces, consumed by Tasks 4 and 5:
  ```go
  // configedit
  func Read(doc []byte, keyPath string) (value any, present bool, err error)
  func SetScalar(doc []byte, keyPath string, v any) (edited []byte, action string, err error)
  func AppendToList(doc []byte, keyPath string, items []string) (edited []byte, action string, added []string, err error)
  func SameOutsideKeys(before, after []byte, keyPaths []string, additive map[string][]string) error
  var ErrShapeUnexpected = errors.New("configedit: shape unexpected")
  ```

- [ ] **Step 1: Write the failing tests for list reads**

In `apps/node-agent/internal/descriptor/configedit/edit_test.go`:

```go
package configedit

import "testing"

const doc = `# the operator's own note, which must survive
approvals:
  mode: ask        # trailing comment
  timeout: 300
  command_allowlist:
    - git status
    - ls
model:
  context_length: 8000
`

func TestReadSeesAListRatherThanCallingItAbsent(t *testing.T) {
	v, present, err := Read([]byte(doc), "approvals.command_allowlist")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if !present {
		t.Fatal("a present list read as absent — the exact false negative this fixes")
	}
	items, ok := v.([]any)
	if !ok || len(items) != 2 {
		t.Fatalf("want a 2-item list, got %#v", v)
	}
}

func TestReadDistinguishesAbsentFromPresent(t *testing.T) {
	if _, present, _ := Read([]byte(doc), "approvals.nothing_here"); present {
		t.Fatal("a key that is not there reported present")
	}
	if _, present, _ := Read([]byte(doc), "approvals.timeout"); !present {
		t.Fatal("a present scalar reported absent")
	}
}

func TestReadOnAnUnparseableDocumentErrorsRatherThanReportingAbsent(t *testing.T) {
	_, present, err := Read([]byte("approvals:\n\t\tbroken: [unclosed\n"), "approvals.timeout")
	if err == nil {
		t.Fatal("an unparseable document must error, never report absent")
	}
	if present {
		t.Fatal("present must be false when the document could not be parsed")
	}
}
```

- [ ] **Step 2: Write the failing tests for editing, and for the guarantee**

```go
func TestSetScalarChangesOneValueAndNothingElse(t *testing.T) {
	edited, action, err := SetScalar([]byte(doc), "approvals.timeout", 900)
	if err != nil {
		t.Fatalf("SetScalar: %v", err)
	}
	if action != "modify" {
		t.Fatalf("action = %q, want modify", action)
	}
	if err := SameOutsideKeys([]byte(doc), edited, []string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("something outside approvals.timeout changed: %v", err)
	}
	if got, _, _ := Read(edited, "approvals.timeout"); got != 900 {
		t.Fatalf("timeout = %#v, want 900", got)
	}
}

func TestAnOperatorsCommentsOrderAndIndentationSurvive(t *testing.T) {
	edited, _, err := SetScalar([]byte(doc), "approvals.timeout", 900)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"# the operator's own note, which must survive",
		"mode: ask        # trailing comment",
		"  context_length: 8000",
	} {
		if !contains(string(edited), want) {
			t.Fatalf("a write reflowed the operator's file: %q is gone", want)
		}
	}
}

// This is F2's test, and the most important one in the file.
func TestAppendToListKeepsEveryEntryTheOperatorAlreadyHad(t *testing.T) {
	edited, action, added, err := AppendToList([]byte(doc), "approvals.command_allowlist",
		[]string{"git status", "npm test"})
	if err != nil {
		t.Fatalf("AppendToList: %v", err)
	}
	if action != "append" {
		t.Fatalf("action = %q, want append", action)
	}
	// "git status" was already there and must not be duplicated; "ls" was the
	// operator's and must not be removed.
	if len(added) != 1 || added[0] != "npm test" {
		t.Fatalf("added = %#v, want only [npm test]", added)
	}
	v, _, _ := Read(edited, "approvals.command_allowlist")
	items := v.([]any)
	if len(items) != 3 {
		t.Fatalf("want 3 entries (ls kept, git status not duplicated, npm test added), got %#v", items)
	}
	var sawLS bool
	for _, it := range items {
		if it == "ls" {
			sawLS = true
		}
	}
	if !sawLS {
		t.Fatal("an additive-only write removed an operator's entry — F2's worst outcome")
	}
}

func TestAppendToListNeverRemoves(t *testing.T) {
	// Declaring a list that does NOT contain the operator's entry must still keep it.
	edited, _, _, err := AppendToList([]byte(doc), "approvals.command_allowlist", []string{"npm test"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SameOutsideKeys([]byte(doc), edited,
		[]string{"approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": {"npm test"}}); err != nil {
		t.Fatalf("an additive write changed more than it added: %v", err)
	}
}

func TestSameOutsideKeysCatchesAChangeElsewhere(t *testing.T) {
	tampered, _, _ := SetScalar([]byte(doc), "model.context_length", 16000)
	if err := SameOutsideKeys([]byte(doc), tampered, []string{"approvals.timeout"}, nil); err == nil {
		t.Fatal("SameOutsideKeys passed a document whose other key changed — the guarantee is not guarding")
	}
}

func TestSetScalarRefusesAShapeItDoesNotKnow(t *testing.T) {
	// approvals is a list here, not a mapping.
	_, _, err := SetScalar([]byte("approvals:\n  - nope\n"), "approvals.timeout", 900)
	if err == nil {
		t.Fatal("writing into an unexpected shape must be refused")
	}
}
```

Add a `contains` helper using `strings.Contains`.

- [ ] **Step 3: Run them and watch them fail**

```bash
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/configedit/
```
Expected: FAIL — the package does not exist.

- [ ] **Step 4: Implement `configedit`**

Follow `internal/hermeslive/config.go` closely — it is the reviewed precedent for every one of these moves. Reuse its approach: `yaml.Unmarshal` into a `yaml.Node` to *decide*, then operate on `splitLines` to *do it*.

Required behaviours:
- `Read` walks a dot-separated `keyPath` through mapping nodes. A scalar decodes to its Go value; a sequence decodes to `[]any`; a mapping at the leaf is `present` with the mapping as its value. A parse error returns `err` with `present` false — never `present` false with a nil error, which is how an unreadable document would pass as an absent key.
- `SetScalar` locates the leaf key's line and replaces only the value portion, preserving leading whitespace and any trailing comment. Creating a missing key inserts a line under its parent at the parent's indent + 2. A parent that exists but is not a mapping is `ErrShapeUnexpected`.
- `AppendToList` adds only items not already present (compared as strings), at the existing list's indentation; it never removes or reorders. A missing key creates the list. A key present but not a sequence is `ErrShapeUnexpected`.
- `SameOutsideKeys` unmarshals both documents to `map[string]any`, deletes each `keyPaths` entry from both, and for each `additive` key removes **only** the named added items from the *after* document before comparing — so an operator's own entries are still compared and must be unchanged. Then `reflect.DeepEqual`.

- [ ] **Step 5: Run the tests until green**

```bash
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/configedit/
```

- [ ] **Step 6: Mutation-test `SameOutsideKeys`**

It is a predicate whose job is to refuse. Prove it can:

```bash
# Temporarily make SameOutsideKeys return nil unconditionally, then:
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/configedit/ 2>&1 | tail -5
```
`TestSameOutsideKeysCatchesAChangeElsewhere` and `TestAppendToListNeverRemoves` MUST fail. Revert the mutation. If either still passes, the test is not testing it — fix the test before continuing.

- [ ] **Step 7: Point Plan 1's reader at the list-capable read**

Update `yamlscalar.go`'s `ObserveConfig` path so a list value reports `Readable: true` with the list as `Observed`, instead of `Readable: false`. Update the Plan 1 test that asserted the old behaviour, and the docs claim in Task 11.

- [ ] **Step 8: Run the whole node suite and commit**

```bash
cd apps/node-agent && go test -race -count=1 ./...
git add -A && git commit -m "node: a key-path config editor that sees lists and proves it touched nothing else"
```

---

## Task 4: `PlanConfig` for Hermes

**Files:**
- Modify: `apps/node-agent/internal/descriptor/config_manage.go`
- Create: `apps/node-agent/internal/descriptor/config_plan.go`
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go`
- Test: `apps/node-agent/internal/descriptor/hermes_config_plan_test.go`

**Interfaces:**
- Consumes: `configedit` (Task 3), `ConfigPlan`/`ConfigReceipt` field names (Task 2), `hermesConfigRegistry` + `hermesConfigPath` + `isCompositeRoot` (Plan 1)
- Produces, consumed by Tasks 5, 6:
  ```go
  type DeclaredSetting struct {
      SettingID string `json:"settingId"`
      Value     any    `json:"value"`
  }
  // on ConfigManager — note the operationID, which the spec's sketch omits:
  // the journal in Task 5 is keyed by it, so planning has to name it.
  PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error)
  ```

**First, extend the test helper.** `hermes_config_test.go:13` has
`hermesWithProfile(t *testing.T, body string) (*hermesDescriptor, string)`, returning the
descriptor and the key `"hermes:one"`. It does **not** return the profile path, and every
test below needs it to read the document back. Change it to return the config file path as
a third value and update Plan 1's existing call sites. Do not build a second fixture
mechanism beside it.

```go
func hermesWithProfile(t *testing.T, body string) (*hermesDescriptor, string, string) {
	// ...unchanged body...
	cfg := filepath.Join(profile, "config.yaml")
	// ...write body to cfg...
	return NewHermes(home).(*hermesDescriptor), "hermes:one", cfg
}
```

- [ ] **Step 1: Write the failing tests**

Create `hermes_config_plan_test.go`:

```go
package descriptor

import (
	"context"
	"os"
	"strings"
	"testing"
)

const planDoc = `# operator's note
approvals:
  mode: ask
  timeout: 300
  command_allowlist:
    - ls
`

func planOne(t *testing.T, h *hermesDescriptor, key, id string, v any) ConfigPlan {
	t.Helper()
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: id, Value: v}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	return p
}

func TestPlanAReconcilableSettingNamesTheEditAndWritesNothing(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	before, _ := os.ReadFile(cfg)
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %+v", p.Refusal)
	}
	if len(p.Entries) != 1 || p.Entries[0].Action != "modify" {
		t.Fatalf("entries = %#v", p.Entries)
	}
	if p.Entries[0].Current != 300 || p.Entries[0].Intended != 900 {
		t.Fatalf("current/intended = %#v/%#v", p.Entries[0].Current, p.Entries[0].Intended)
	}
	if p.PlanDigest == "" {
		t.Fatal("a plan with no digest cannot be applied")
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("PlanConfig wrote to the document — planning must write nothing")
	}
}

func TestPlanIsDeterministicForTheSameDocument(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	a := planOne(t, h, key, "hermes.approvals.timeout", 900)
	b := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if a.PlanDigest != b.PlanDigest {
		t.Fatal("two plans of one unchanged document differ — PLAN_STALE would fire on every apply")
	}
}

func TestPlanDigestChangesWhenTheDocumentChanges(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	a := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if err := os.WriteFile(cfg, []byte(planDoc+"model:\n  context_length: 8000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if a.PlanDigest == b.PlanDigest {
		t.Fatal("the digest ignored a document change — a stale plan would apply silently")
	}
}

func TestPlanRefusesAnUnregisteredSettingByName(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.nope", 1)
	if p.Refusal == nil || p.Refusal.Code != "UNKNOWN_SETTING" {
		t.Fatalf("refusal = %+v, want UNKNOWN_SETTING", p.Refusal)
	}
	if !strings.Contains(p.Refusal.Message, "hermes.approvals.nope") {
		t.Fatalf("a refusal must name the id it refused: %q", p.Refusal.Message)
	}
}

func TestPlanOnAnUnparseableDocumentRefusesWithUnreadable(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n\t\tbroken: [unclosed\n")
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.Refusal == nil || p.Refusal.Code != "UNREADABLE" {
		t.Fatalf("refusal = %+v, want UNREADABLE", p.Refusal)
	}
	if len(p.Entries) != 0 {
		t.Fatal("an unreadable document produced edit entries")
	}
}

func TestPlanOfAnAdditiveOnlySettingPlansAnAppendNotAReplace(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.command_allowlist", []string{"npm test"})
	if len(p.Entries) != 1 || p.Entries[0].Action != "append" {
		t.Fatalf("entries = %#v, want one append", p.Entries)
	}
	got, ok := p.Entries[0].Intended.([]any)
	if !ok {
		t.Fatalf("intended = %#v, want a list", p.Entries[0].Intended)
	}
	var sawLS bool
	for _, v := range got {
		if v == "ls" {
			sawLS = true
		}
	}
	if !sawLS {
		t.Fatal("the intended value dropped the operator's own entry — F2's worst outcome, planned")
	}
}

func TestPlanOfAMatchingValueIsANoOp(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.timeout", 300)
	if !p.NoOp || p.Entries[0].Action != "noop" {
		t.Fatalf("noOp = %v, action = %q", p.NoOp, p.Entries[0].Action)
	}
	if p.RestartRequired {
		t.Fatal("a no-op claimed a restart was required — nothing changed to take effect")
	}
}

// NOTE: this reads the expectation from the registry rather than hardcoding
// `true`. Task 1 may have replaced the unverified assumption with evidence
// that approvals.timeout hot-reloads — in which case a hardcoded `true` here
// would be a test asserting the opposite of the registry it is testing.
func TestPlanCarriesRestartRequiredOnlyForEntriesThatChangeSomething(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	var want bool
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.timeout" {
			want = s.RestartToTakeEffect
		}
	}
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.RestartRequired != want {
		t.Fatalf("restartRequired = %v, want %v (the registry's value for this setting)",
			p.RestartRequired, want)
	}
}

func TestPlanRefusesAProfileScopedSettingOnTheCompositeRoot(t *testing.T) {
	h, _, _ := hermesWithProfile(t, planDoc)
	p, err := h.PlanConfig(context.Background(), "hermes", "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "OUT_OF_SCOPE" {
		t.Fatalf("refusal = %+v, want OUT_OF_SCOPE", p.Refusal)
	}
}
```

**Also write `TestPlanRefusesACredentialPath`.** It needs a registry entry whose path
resolves to `auth.json` or `.env`, which the shipped registry has none of — so inject a
test-only entry through whatever seam `hermesConfigRegistry` allows, or make the path
check a separately testable function and test it directly. Do **not** add a credential
setting to the real registry to make a test pass.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/ -run Plan
```
Expected: FAIL — `PlanConfig` is not defined.

- [ ] **Step 3: Add the Go plan structs**

In `config_plan.go`, mirroring Task 2's zod field names exactly, and `internal/hermeslive/operation.go`'s digest approach:

```go
// ConfigRefusal is why a plan will not be offered. Every code is distinct and
// carries a sentence: a refusal that cannot be told from a pass is the failure
// this area keeps hitting. Codes are spec §9's set, and the JSON tags match
// the contract's `ConfigRefusal`.
type ConfigRefusal struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ConfigPlanEntry is one setting's intended edit. Current is omitted when the
// key is not in the document — which is NOT the same as a nil value, and the
// reason this is `any` with omitempty rather than a typed zero.
type ConfigPlanEntry struct {
	SettingID           string `json:"settingId"`
	File                string `json:"file"`
	KeyPath             string `json:"keyPath"`
	Policy              string `json:"policy"`
	Current             any    `json:"current,omitempty"`
	Intended            any    `json:"intended"`
	Action              string `json:"action"` // create | modify | append | noop
	RestartToTakeEffect bool   `json:"restartToTakeEffect"`
}

// ConfigWritten is what an apply actually wrote, per setting.
type ConfigWritten struct {
	SettingID string `json:"settingId"`
	Action    string `json:"action"`
	Wrote     any    `json:"wrote"`
}

// ConfigReceipt is the journal entry for one apply. There is deliberately no
// `restarted` field: nothing here restarts a harness (D4).
type ConfigReceipt struct {
	Plan        ConfigPlan      `json:"plan"`
	Phase       string          `json:"phase"` // planned | applying | applied | conflict
	UpdatedAt   string          `json:"updatedAt"`
	Written     []ConfigWritten `json:"written"`
	AfterSHA256 string          `json:"afterSha256,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// ConfigPlan is what review sees. The digest covers every field in it,
// including BeforeSHA256, so a document edited after review yields a
// different digest and the apply is refused rather than re-derived (D8).
type ConfigPlan struct {
	SchemaVersion   int               `json:"schemaVersion"`
	OperationID     string            `json:"operationId"`
	StationKey      string            `json:"stationKey"`
	Entries         []ConfigPlanEntry `json:"entries"`
	BeforeSHA256    string            `json:"beforeSha256"`
	Diff            string            `json:"diff"`
	DiffTruncated   bool              `json:"diffTruncated"`
	NoOp            bool              `json:"noOp"`
	Refusal         *ConfigRefusal    `json:"refusal,omitempty"`
	RestartRequired bool              `json:"restartRequired"`
	CreatedAt       string            `json:"createdAt"`
	PlanDigest      string            `json:"planDigest"`
}

func configDigestOf(p ConfigPlan) string {
	p.PlanDigest = ""
	data, _ := json.Marshal(p)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
```

Note the `CreatedAt` hazard: a timestamp inside the digest makes two plans of the same document differ, which breaks `TestPlanIsDeterministicForTheSameDocument` and with it PLAN_STALE. Exclude `CreatedAt` and `OperationID` from the digest the same way `PlanDigest` is excluded — zero them in the copy before marshalling — and add a comment saying why.

- [ ] **Step 4: Implement `PlanConfig` on the Hermes descriptor**

Order of checks, each producing its own refusal:
1. Resolve the document path via `hermesConfigPath`. If it resolves to a credential file (basename `auth.json` or `.env`, or any path segment named `credentials`) → `CREDENTIAL_PATH`. **First**, before reading anything.
2. Composite-root or scope mismatch → `OUT_OF_SCOPE` (reuse Plan 1's `isCompositeRoot`).
3. Any requested id not in `hermesConfigRegistry` → `UNKNOWN_SETTING`, naming it.
4. Read the document. Parse failure → `UNREADABLE`.
5. Per setting, by policy: `reconcilable` → `configedit.SetScalar` dry-run; `additive-only` → `configedit.AppendToList` dry-run; `report-only` → always `noop`.
6. `configedit.SameOutsideKeys` on the derived result. A violation is `SHAPE_UNEXPECTED` — the plan refuses rather than offering an edit it cannot prove is contained.
7. Build the diff with the same `DiffLines` + `maxDiff` truncation `hermeslive` uses.

`PlanConfig` writes nothing. Derive the edited bytes in memory only.

- [ ] **Step 5: Run the tests until green, then the whole package**

```bash
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "node: Hermes plans a config edit, and names every refusal"
```

---

## Task 5: `ApplyConfig`, and the journal that makes inspect possible

**Files:**
- Modify: `apps/node-agent/internal/descriptor/config_manage.go`
- Create: `apps/node-agent/internal/descriptor/config_journal.go`
- Modify: `apps/node-agent/internal/descriptor/hermes_config.go`
- Test: `apps/node-agent/internal/descriptor/hermes_config_apply_test.go`

**Interfaces:**
- Consumes: Task 4's `PlanConfig`, `configedit` (Task 3)
- Produces, consumed by Tasks 6, 7:
  ```go
  ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error)
  InspectConfig(ctx context.Context, key, operationID string) (ConfigReceipt, error)
  ```

- [ ] **Step 1: Write the failing tests**

```go
func applyPlanned(t *testing.T, h *hermesDescriptor, key, id string, v any) (ConfigPlan, ConfigReceipt) {
	t.Helper()
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: id, Value: v}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	return p, r
}

func TestApplyWritesTheReviewedPlan(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	_, r := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	if len(r.Written) != 1 || r.Written[0].SettingID != "hermes.approvals.timeout" {
		t.Fatalf("written = %#v", r.Written)
	}
	body, _ := os.ReadFile(cfg)
	if !strings.Contains(string(body), "timeout: 900") {
		t.Fatalf("the document was not written:\n%s", body)
	}
}

// This is D8's test.
func TestApplyRefusesAPlanTheDocumentNoLongerMatches(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatal(err)
	}
	// The operator edits the file between review and apply.
	changed := planDoc + "model:\n  context_length: 8000\n"
	if err := os.WriteFile(cfg, []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("a stale plan must be an answer, not an error: %v", err)
	}
	if r.Phase != "conflict" {
		t.Fatalf("phase = %q, want conflict", r.Phase)
	}
	if r.Plan.Refusal == nil || r.Plan.Refusal.Code != "PLAN_STALE" {
		t.Fatalf("refusal = %+v, want PLAN_STALE", r.Plan.Refusal)
	}
	body, _ := os.ReadFile(cfg)
	if string(body) != changed {
		t.Fatal("a REFUSED apply still wrote to the document")
	}
}

func TestApplyRefusesADigestThatWasNeverPlanned(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	if _, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cfg)
	r, err := h.ApplyConfig(context.Background(), key, "op_1", strings.Repeat("f", 64))
	if err == nil && r.Phase == "applied" {
		t.Fatal("a fabricated digest was applied")
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a fabricated digest still wrote to the document")
	}
}

func TestApplyIsIdempotentForTheSameOperation(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, first := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	once, _ := os.ReadFile(cfg)
	second, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if second.Phase != "applied" {
		t.Fatalf("phase = %q, want applied from the journal", second.Phase)
	}
	twice, _ := os.ReadFile(cfg)
	if string(once) != string(twice) {
		t.Fatal("applying the same operation twice edited the document twice")
	}
	_ = first
}

// Spec §10.1, asserted rather than assumed.
func TestApplyChangesNoKeyOutsideThePlan(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	before, _ := os.ReadFile(cfg)
	applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	after, _ := os.ReadFile(cfg)
	if err := configedit.SameOutsideKeys(before, after,
		[]string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("an apply changed something outside its plan: %v", err)
	}
	// And D5: the operator's file was not reflowed.
	if !strings.Contains(string(after), "# operator's note") {
		t.Fatal("the operator's comment did not survive the write")
	}
}

// F2, now through the real apply path and onto disk.
func TestApplyOfAnAdditiveOnlySettingKeepsTheOperatorsEntries(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	applyPlanned(t, h, key, "hermes.approvals.command_allowlist", []string{"npm test"})
	body, _ := os.ReadFile(cfg)
	if !strings.Contains(string(body), "ls") {
		t.Fatalf("an additive-only apply removed the operator's grant:\n%s", body)
	}
	if !strings.Contains(string(body), "npm test") {
		t.Fatalf("the declared entry was not added:\n%s", body)
	}
}

// Like the plan-side restart test, this takes its expectation from the
// registry: Task 1 may have settled that approvals.timeout hot-reloads.
// The invariant that does NOT depend on Task 1 is the second half — a
// receipt never claims anything about restarting.
func TestApplyReportsRestartRequiredAndRestartsNothing(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	var want bool
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.timeout" {
			want = s.RestartToTakeEffect
		}
	}
	_, r := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	if r.Plan.RestartRequired != want {
		t.Fatalf("restartRequired = %v, want %v (the registry's value)", r.Plan.RestartRequired, want)
	}
	// The receipt describes a WRITE, never an effect. Spec §10.8 / D4.
	data, _ := json.Marshal(r)
	if strings.Contains(string(data), "restarted") {
		t.Fatalf("the receipt claims something about restarting: %s", data)
	}
}

func TestInspectReturnsTheRecordedReceiptWithoutReplanning(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, _ := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	// Change the document; inspect must still show what was REVIEWED.
	if err := os.WriteFile(cfg, []byte(planDoc), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := h.InspectConfig(context.Background(), key, "op_1")
	if err != nil {
		t.Fatalf("InspectConfig: %v", err)
	}
	if got.Plan.PlanDigest != p.PlanDigest {
		t.Fatal("inspect re-derived the plan instead of returning the reviewed one")
	}
	if _, err := h.InspectConfig(context.Background(), key, "op_nope"); err == nil {
		t.Fatal("an unknown operation id returned a receipt instead of an error")
	}
}
```

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement the journal**

Mirror `internal/hermeslive`'s journal rather than inventing a second mechanism — read it first. One file per station under the node's own state directory (never inside the harness's config directory, which F1 says the harness rewrites). Keyed by `operationID`, storing the `ConfigReceipt`.

- [ ] **Step 4: Implement `ApplyConfig`**

```
1. Load the journal entry for operationID.
   - absent                                  → error (not a silent plan)
   - present and Phase == "applied"          → return it unchanged (idempotent)
2. Check the supplied planDigest == journal entry's plan.PlanDigest, else refuse.
3. RE-DERIVE the plan from the document as it is NOW (call the same code path
   PlanConfig uses).
4. If the re-derived digest != the journal's digest → Phase "conflict",
   refusal PLAN_STALE. WRITE NOTHING.
5. Write the edited bytes. Then verify on the bytes actually written:
   configedit.SameOutsideKeys(before, after, touched, additive).
   A violation after a write is a hard error recorded in the receipt — and
   because step 3 already proved containment, reaching here means the
   filesystem changed under us, which is exactly a conflict.
6. Record the receipt: Phase "applied", Written, AfterSHA256. Never restart.
```

Write via the same atomic temp-file-plus-rename the existing config writers use (find it; do not add a second write path).

- [ ] **Step 5: Run the tests until green**

- [ ] **Step 6: Mutation-test the staleness check**

```bash
# Temporarily make the step-4 digest comparison always pass, then:
cd apps/node-agent && go test -race -count=1 ./internal/descriptor/ -run Apply 2>&1 | tail -5
```
`TestApplyRefusesAPlanTheDocumentNoLongerMatches` MUST fail. Revert.

- [ ] **Step 7: Run the whole node suite and commit**

```bash
cd apps/node-agent && go test -race -count=1 ./...
git add -A && git commit -m "node: apply a reviewed config plan, refuse a stale one, restart nothing"
```

---

## Task 6: The three broker verbs

**Files:**
- Modify: `apps/node-agent/internal/descriptor/handler.go`
- Test: `apps/node-agent/internal/descriptor/handler_test.go` (exists)

**Interfaces:**
- Consumes: Tasks 4 and 5
- Produces, consumed by Task 7 — broker verbs beside Plan 1's `config.observe` / `config.settings`:
  - `config.plan` — params `{stationKey, operationId, want: [{settingId, value}]}` → `ConfigPlan`
  - `config.inspect` — params `{stationKey, operationId}` → `ConfigReceipt`
  - `config.apply` — params `{stationKey, operationId, planDigest}` → `ConfigReceipt`

- [ ] **Step 1: Write the failing tests**

Follow the existing `config.observe` test at `handler_test.go:144` exactly in shape. Cover: each verb routes; a descriptor that does not implement `ConfigManager` is refused by name ("<harness> does not manage configuration"); bad params are a param error, not a panic; none of the three is streamed.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Add the three cases** beside `case "config.observe":` at `handler.go:58`, following the surrounding style precisely.

- [ ] **Step 4: Run the tests, then the suite, and commit**

```bash
cd apps/node-agent && go test -race -count=1 ./...
git add -A && git commit -m "node: config.plan, config.inspect and config.apply reach the descriptor"
```

---

## Task 7: Hub — the plan/inspect/apply trio, and the two new tables

**Files:**
- Create: `apps/hub/src/db/schema/harness-config-ops.ts`
- Create: `apps/hub/src/db/drizzle-migrations/00NN_harness_config_ops.sql`
- Modify: `apps/hub/src/db/schema/index.ts`, `apps/hub/src/db/tenant-scope.ts`
- Create: `apps/hub/src/services/harness-config-apply.ts`
- Modify: `apps/hub/src/routes/harness-config.ts`
- Test: `apps/hub/tests/integration/harness-config-apply.test.ts`

**Interfaces:**
- Consumes: Task 6's broker verbs; `resolveFor`, `compare`, `fetchRegistry`, `verifySettingKnown`, `nonHumanRefusal` (Plan 1)
- Produces, consumed by Tasks 8, 9, 10:
  ```ts
  planFor(args): Promise<ConfigPlan>
  applyFor(args): Promise<ConfigReceipt>
  recordApplied(args: { tenantId, stationId, settingId, gatewayPid, gatewayUptimeSec, appliedAt }): Promise<void>
  ```

**Two hazards from Plan 1, both of which cost a fix round there. Do not repeat them:**

1. **Postgres NULL ≠ NULL.** Any `onConflictDoUpdate` whose target includes a nullable column inserts duplicates instead of conflicting. Plan 1's `declared_harness_config` needed a *partial* unique index for the fleet level. `applied_harness_config` is keyed on `(tenant_id, station_id, setting_id)` with no nullable column in the key, so a plain unique constraint is correct here — but verify that before using one.
2. **`tenant-scope.ts` must register every new table.** `tenantScope()` throws for an unregistered table, and the tenant-isolation tests will fail opaquely. Both new tables go in.

Also: `tenants.id` is CHECK-constrained to `fleet_<20 hex>`. Test fixtures must use a conforming id — `tnt_test` is invalid and will fail at insert.

- [ ] **Step 1: Write the schema and generate the migration**

```ts
// apps/hub/src/db/schema/harness-config-ops.ts

/**
 * What this system has actually written to a station, and the gateway it was
 * written under. The pid is the restart evidence `awaiting-restart` needs:
 * Hermes multiplexes one gateway across profiles, so that pid IS the process
 * that re-reads config. See plan ruling R2.
 */
export const appliedHarnessConfig = pgTable("applied_harness_config", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  stationId: text("station_id").notNull(),
  settingId: text("setting_id").notNull(),
  value: jsonb("value").notNull(),
  gatewayPid: integer("gateway_pid"),
  gatewayUptimeSec: integer("gateway_uptime_sec"),
  appliedAt: timestamp("applied_at").defaultNow().notNull(),
}, (t) => [ unique("applied_cfg_station_setting").on(t.tenantId, t.stationId, t.settingId) ]);

/**
 * An operator's explicit opt-out. Keyed on the STATION KEY rather than the row
 * id so it survives unadopt/re-adopt (ruling R1's stated mitigation).
 */
export const harnessConfigOptOut = pgTable("harness_config_opt_out", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  stationKey: text("station_key").notNull(),
  settingId: text("setting_id").notNull(),
  reason: text("reason"),
  optedOutBy: text("opted_out_by").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [ unique("cfg_opt_out_key_setting").on(t.tenantId, t.stationKey, t.settingId) ]);
```

Register both in `schema/index.ts` and `tenant-scope.ts`, then:

```bash
cd apps/hub && bun run db:generate
```

**Take the number drizzle assigns.** Plan 1 hit a collision because main's migrations landed in between; if `bun run db:generate` re-emits DDL that is already live, main has added hand-written migrations without snapshots again — strip the re-emitted objects, keep only the two new tables, and say so in the commit message. Confirm with a second `bun run db:generate` reporting "No schema changes".

- [ ] **Step 2: Write the failing integration tests**

In `apps/hub/tests/integration/harness-config-apply.test.ts`, with per-file row cleanup in `afterAll` and a `fleet_<20 hex>` tenant id:

```
- plan proxies to the node and returns the node's plan unchanged
- plan for a station on an offline node is a 502, not an empty plan
- apply requires the digest the plan returned; a different digest is refused
- apply records applied_harness_config with the gateway pid from health
- apply by a non-human principal is refused (reuse Plan 1's nonHumanRefusal)
- an unregistered setting id is refused before the node is ever asked
- a station in another tenant is not visible to plan, inspect or apply
```

- [ ] **Step 3: Run them and watch them fail**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/integration/harness-config-apply.test.ts
```

If the whole file errors with a failed `CREATE TABLE`, the test database is carrying an older hash of this migration — drop and recreate it, which is a local-only artefact of renumbering:

```bash
docker exec agentpod-test-postgres psql -U agentpod -d postgres \
  -c 'DROP DATABASE IF EXISTS agentpod WITH (FORCE);' -c 'CREATE DATABASE agentpod OWNER agentpod;'
```

- [ ] **Step 4: Implement the service and the three routes**

Routes, authorised exactly as Plan 1's are (`AuthUser` off `c.get("user")`, the same tenant resolution, the same `nonHumanRefusal`):

- `POST /api/stations/:stationId/config/plan` → body `{settings: [{settingId, value?}]}`; when `value` is omitted the declared value is resolved via `resolveFor`
- `GET  /api/stations/:stationId/config/operations/:operationId`
- `POST /api/stations/:stationId/config/apply` → body `{operationId, planDigest}`

Validate ids against the live registry (`fetchRegistry`, never cached) before touching the broker. On a successful apply, read the station's health for the gateway pid and call `recordApplied`.

- [ ] **Step 5: Run the file, then the whole hub suite, and commit**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test
```
Expected: the full suite green. `bun run typecheck` is KNOWN RED at its documented count — do not "fix" those in passing, and do not let the count rise.

```bash
git add -A && git commit -m "hub: plan, inspect and apply a declared setting against a station"
```

---

## Task 8: Reconcile at adopt time, and never fail an adoption

Spec §5: "On adopt, after the station is registered: observe, then apply the `reconcilable` and `additive-only` settings whose declared value differs. Failures are recorded against the station and do not fail the adoption — a station that is adopted with one setting unwritten is better than one not adopted."

**Files:**
- Modify: `apps/hub/src/services/station-registry.ts`
- Modify: `apps/hub/src/services/harness-config-apply.ts`
- Test: `apps/hub/tests/integration/harness-config-adopt.test.ts`

**Interfaces:**
- Consumes: `adoptStations` (`station-registry.ts:40`), Task 7's `planFor`/`applyFor`
- Produces: `reconcileOnAdopt(tenantId, stations): Promise<ReconcileOutcome[]>`

- [ ] **Step 1: Write the failing tests**

```
- a station adopted with a fleet-level declaration gets the value written
- a station whose node is offline is STILL ADOPTED, with the failure recorded
- a node that refuses the apply does not fail the adoption
- a reconcilable setting already matching is not written (no-op, no receipt)
- a report-only setting is NEVER written on adopt
- an opted-out setting is not written on adopt
- adopting 3 stations where the middle one fails adopts all 3
- the reconcile runs AFTER the station row exists (a plan needs the station)
```

That last one matters: call the hook after the upsert, not inside it.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement `reconcileOnAdopt`**

Call it from `adoptStations` after the rows are written and the return value is built. Wrap the entire body so that **no throw can escape** — the test "adopting 3 stations where the middle one fails adopts all 3" is the one that proves it. Per station, per setting: skip `report-only`, skip opted-out, skip already-matching; otherwise plan then apply with the plan's own digest.

Record each failure against the station. Use the existing mechanism for station-scoped problems rather than adding a new one — find how `statusReason` is used on runtimes and follow it.

- [ ] **Step 4: Run the tests, then the whole hub suite**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "hub: adopt reconciles declared settings, and an adoption survives a failed write"
```

---

## Task 9: `awaiting-restart` and `opted-out` become reachable

Plan 1's `compare()` emits five of seven states, and both the docs page and its tests say the other two are "reachable only once writing ships". This is that.

**Files:**
- Modify: `apps/hub/src/services/harness-config.ts`
- Test: `apps/hub/tests/unit/harness-config-compare.test.ts` (exists)

**Interfaces:**
- Consumes: `appliedHarnessConfig`, `harnessConfigOptOut` (Task 7), `compare()` (Plan 1)
- Produces: `compare()` emitting all seven states; `optOut`/`clearOptOut`

- [ ] **Step 1: Write the failing tests**

```
- a setting written under a gateway pid that is STILL RUNNING is awaiting-restart
- the same setting after the gateway pid CHANGED is matches
- a station whose health reports no pid stays awaiting-restart, never matches
- a setting that needs no restart is `matches` immediately after a write
- an opted-out setting is `opted-out` even when the observed value differs
- opted-out beats drifted: the state names the operator's choice, not the diff
- clearing an opt-out returns the setting to ordinary comparison
```

The second and fifth are the load-bearing ones: the first proves the restart evidence works, the second proves D6's precedence.

**A native harness opt-out is deliberately NOT in this task.** `compare()` is a pure
function over declared and observed values, and Plan 1's `ConfigValue` carries no
opt-out signal — so a `plugins.disabled` entry is invisible to it. The only native
opt-out any harness has today governs the plugins settings that **Plan 3** folds in,
so native opt-out detection lands with them, where the `ConfigValue` change it needs
can be designed against a real case. Do not add a speculative field for it here.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Extend `compare()`**

Precedence, highest first — write it as an ordered list in a comment, because a state machine whose order is implicit is how `opted-out` silently becomes `drifted`:

```
1. out-of-scope   (declaration cannot apply to this station at all)
2. unreadable     (the document could not be parsed — never "matches")
3. opted-out      (an explicit operator choice, hub register or native key)
4. awaiting-restart (written, restart needed, gateway pid unchanged)
5. absent / drifted / matches  (the ordinary comparison)
```

`compare()` gains the applied-write rows and the opt-out rows as inputs. Keep it a pure function of its arguments, as Plan 1 left it — fetch in the caller.

- [ ] **Step 4: Mutation-test the precedence**

```bash
# Temporarily reorder so `drifted` is decided before `opted-out`, then:
cd apps/hub && DATABASE_URL="..." bun test tests/unit/harness-config-compare.test.ts 2>&1 | tail -5
```
"opted-out beats drifted" MUST fail. Revert.

- [ ] **Step 5: Run the hub suite and commit**

```bash
git add -A && git commit -m "hub: all seven observation states, with restart evidence and an operator's opt-out"
```

---

## Task 10: `fleet config plan | inspect | apply`

**Files:**
- Modify: `apps/node-agent/cmd/agentpod-fleet/config.go`
- Test: `apps/node-agent/cmd/agentpod-fleet/config_test.go` (follow the existing test file's shape)

**Interfaces:**
- Consumes: Task 7's routes
- Produces: the three verbs in spec §8's shape

- [ ] **Step 1: Write the failing tests**

Cover: each verb's flags parse; `apply` without `--plan-digest` is a usage error, never a write; usage text lists all nine verbs; `plan` prints the digest that `apply` needs.

- [ ] **Step 2: Run them and watch them fail**

- [ ] **Step 3: Implement the verbs**

Extend `configUsage` (currently six verbs at `config.go:13`) to:

```
  fleet config plan    --station ID                 the edit that would be made, and its digest
  fleet config inspect --station ID --operation ID  a plan already made, as it was reviewed
  fleet config apply   --station ID --operation ID --plan-digest SHA256
```

Keep Plan 1's load-bearing usage line — `set` records a declaration and does not write — and add one to `apply` naming what it does write. Follow the existing `flag.NewFlagSet` style in this file exactly.

- [ ] **Step 4: Run the tests, then the suite, and commit**

```bash
cd apps/node-agent && go test -race -count=1 ./...
git add -A && git commit -m "fleet: plan, inspect and apply a declared setting from the CLI"
```

---

## Task 11: The docs page says what is now true

`docs-site/src/content/docs/use/config.md` currently says writing does not exist. After Tasks 1–10 that page is wrong in at least five specific places, and a docs page that overstates is the failure this estate has already shipped twice.

**Files:**
- Modify: `docs-site/src/content/docs/use/config.md`
- Test: `apps/hub/tests/unit/docs-claims.test.ts` (exists — it parses docs pages for CLI claims)

- [ ] **Step 1: List what the page now gets wrong**

```bash
grep -n "once writing ships\|not a write\|unreadable" docs-site/src/content/docs/use/config.md
```

At minimum: the `## A declaration is not a write` section (still true of `set`, now false as a description of the system), the three policy-table rows ending "once writing ships", both `opted-out` and `awaiting-restart` rows calling themselves unreachable, and `### List-valued settings read as unreadable` — which Task 3 fixed.

- [ ] **Step 2: Rewrite those sections**

Required content:
- `set` declares; `apply` writes; the gap is the design. Keep that distinction — it is still the truth and it is the page's most useful sentence.
- The plan → inspect → apply flow, with a worked `fleet config` example carrying a real digest.
- Adopt-time reconcile: what gets written, and that a failure does not fail an adoption.
- `awaiting-restart` means written but not live, and **agentpod will not restart the harness for you** (D4).
- `opted-out`, and where the opt-out lives (ruling R1).
- Delete the list-valued `unreadable` caveat.
- Every refusal code from spec §9, each with the sentence that distinguishes it.

**Write only what the code does.** Check each claim against the implementation, not against this plan — this plan is an argument, the code is the fact.

- [ ] **Step 3: Verify the docs-claims test still parses the page**

```bash
cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" \
  bun test tests/unit/docs-claims.test.ts
```

Its regexes were widened to `[a-z][a-z-]*` in PR #652 precisely because a narrower pattern silently skipped hyphenated commands. If you add a command shape it cannot see, widen it **and mutation-test the widening** — a check that matches less is a check that stopped checking.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: declared config can be applied, and what each refusal means"
```

---

## Self-review notes

**Spec coverage.** D1 → Task 4 step 4.3. D2 → Tasks 3, 4 (policy per setting). D3 → Task 8 (adopt only; nothing in this plan runs on a tick). D4 → Tasks 5, 9, 11. D5 → Task 3. D6 → Tasks 8, 9, ruling R1. D7 → Task 4. D8 → Tasks 4, 5. F1 → Task 5 step 3 (journal outside the harness directory). F2 → Tasks 3, 5 (the two tests named most important). F4 → Task 9, ruling R2. §9's seven refusals → Task 2 step 3, exercised across 4, 5, 7. §10's nine tests → 10.1 Task 5; 10.2 Tasks 3, 5; 10.3 Task 3; 10.4 Task 9; 10.5 Tasks 3, 4; 10.6 Task 4; 10.7 Task 5; 10.8 Tasks 5, 9; **10.9 is Plan 3**, with the folding-in.

**Deliberately deferred to Plan 3:** the four folded-in settings under the byte-identical guarantee, and the console panel. Both are in the spec; neither is needed for the write path to work end to end, and the folding-in is regression work on four shipped verbs rather than new construction.

**Known gap.** Task 1 may not be able to settle the restart question without a live experiment on a running gateway. The plan's position is that `true` stands unless evidence says otherwise, which is the spec's own argument. An implementer must not resolve this by guessing, and must not label it verified without a citation.
