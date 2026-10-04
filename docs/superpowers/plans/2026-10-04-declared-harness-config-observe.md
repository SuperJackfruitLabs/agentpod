# Declared harness configuration — Plan 1: declare and observe

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare a harness setting fleet-wide and see, per station, whether the station agrees — with **nothing writing to a harness's config file**.

**Architecture:** The node gains one optional descriptor interface whose only method here is a *read*; Hermes implements it for three `approvals.*` settings. The hub stores declarations, resolves station → node → fleet precedence, and compares. `fleet config` exposes it. Writing is Plan 2.

**Tech Stack:** Go (node-agent), Bun + Hono + Drizzle/Postgres (hub), zod (contract).

**Spec:** `docs/superpowers/specs/2026-10-04-declared-harness-config-design.md`

## Why this is Plan 1 of 2

The spec splits on a risk boundary, and the split is worth taking:

- **Plan 1 (this one) touches no harness file.** It proves the registry, the scope model and the precedence rules while the worst possible bug is a wrong readout.
- **Plan 2** adds `PlanConfig`/`ApplyConfig`, the plan digest, adopt-time reconcile, the console's apply control, and folds in the four settings `hermes-live`/`hermes-skills`/`openclaw-errors` already own.

Plan 1 ships working software on its own: declare `hermes.approvals.timeout = 900` and `fleet config drift` names every station that disagrees — which is already the answer to "why did nobody know this station was different".

**Out of scope for Plan 1, deliberately:** any write to a harness document; `PlanConfig`/`ApplyConfig`; adopt-time reconcile; the console panel (`fleet config drift` carries the value, and the console lands with the apply control it needs in Plan 2); harnesses other than Hermes (§6 of the spec: Hermes is the only one where a per-station setting is honest).

## Global Constraints

Copied from the spec and `CLAUDE.md`; every task's requirements include these.

- **TDD, failing test first.** A test that passed on first write is not evidence. A widened predicate must be mutation-tested.
- **The node never decides drift.** `ObserveConfig` returns `ConfigValue` (observed only). Comparison is the hub's, because only the hub resolves station → node → fleet precedence.
- **An unparseable document is `readable: false`, never an absent key.** Nothing is inferred from a failed read.
- **No writes to any harness document in this plan.** Not even a safe-looking one.
- **No restarts.** Nothing in this plan restarts a station.
- **`CREDENTIAL_PATH` is a hard refusal.** A setting whose file resolves to `auth.json` or `.env` is refused, not warned about.
- **Change `packages/contract` first** when a wire shape changes (`CLAUDE.md`).
- **Required CI checks:** `contract`, `hub`, `node-agent`, `console`, `worker`. Branch must be up to date before merge (`strict`).
- Hub tests need pgvector on `:5434` **and** an explicit `DATABASE_URL` override — see `TESTING.md`.
- Product vocabulary only: no local workspace or agent names in code, comments, fixtures or docs.

## File Structure

| file | responsibility |
|---|---|
| `packages/contract/src/harness-config.ts` | **create** — the six wire types |
| `packages/contract/src/index.ts` | **modify** — export them |
| `packages/contract/test/harness-config.test.ts` | **create** — shape tests |
| `apps/node-agent/internal/descriptor/yamlscalar.go` | **create** — a nesting-aware scalar reader, extracted from `multiplexProfiles` |
| `apps/node-agent/internal/descriptor/yamlscalar_test.go` | **create** |
| `apps/node-agent/internal/descriptor/hermes.go` | **modify** — `multiplexProfiles` uses the extracted reader |
| `apps/node-agent/internal/descriptor/config_manage.go` | **create** — the `ConfigManager` interface and its Go types |
| `apps/node-agent/internal/descriptor/hermes_config.go` | **create** — Hermes' registry + `ObserveConfig` |
| `apps/node-agent/internal/descriptor/hermes_config_test.go` | **create** |
| `apps/node-agent/internal/descriptor/registry.go` | **modify** — advertise `config.manage` |
| `apps/node-agent/internal/descriptor/handler.go` | **modify** — the `config.observe` verb |
| `apps/hub/src/db/schema/harness-config.ts` | **create** — declared state |
| `apps/hub/src/db/drizzle-migrations/` | **create** — one generated migration |
| `apps/hub/src/services/harness-config.ts` | **create** — resolve precedence, compare, produce observations |
| `apps/hub/src/routes/harness-config.ts` | **create** — the four read/declare routes |
| `apps/node-agent/cmd/agentpod-fleet/config.go` | **create** — `fleet config …` |
| `apps/node-agent/cmd/agentpod-fleet/fleet.go` | **modify** — dispatch `config` |
| `apps/node-agent/cmd/agentpod-fleet/help.go` | **modify** — one help line |
| `docs-site/src/content/docs/use/config.md` | **create** — the published page |
| `docs-site/astro.config.mjs` | **modify** — sidebar entry |

---

### Task 1: Contract types

**Files:**
- Create: `packages/contract/src/harness-config.ts`
- Modify: `packages/contract/src/index.ts`
- Test: `packages/contract/test/harness-config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ConfigScope`, `ConfigPolicy`, `ConfigSetting`, `DeclaredSetting`, `ConfigValue`, `ConfigObservation` — zod schemas and inferred types, all exported from `@agentpod/contract`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/contract/test/harness-config.test.ts
import { describe, test, expect } from "bun:test";
import {
  ConfigScope, ConfigPolicy, ConfigSetting, DeclaredSetting, ConfigValue, ConfigObservation,
} from "../src/harness-config";

describe("harness config contract", () => {
  test("a setting declares its harness, scope, policy and restart need", () => {
    const parsed = ConfigSetting.parse({
      id: "hermes.approvals.timeout",
      harness: "hermes",
      scope: "profile",
      policy: "reconcilable",
      restartToTakeEffect: true,
    });
    expect(parsed.id).toBe("hermes.approvals.timeout");
  });

  test("scope and policy are closed vocabularies", () => {
    expect(ConfigScope.safeParse("profile").success).toBe(true);
    expect(ConfigScope.safeParse("station").success).toBe(false);
    expect(ConfigPolicy.safeParse("additive-only").success).toBe(true);
    expect(ConfigPolicy.safeParse("overwrite").success).toBe(false);
  });

  test("restartToTakeEffect is required — an omitted one must not read as false", () => {
    // Spec F4: claiming no restart is needed when one is produces the drift this
    // whole design exists to end, so the field may not default.
    const r = ConfigSetting.safeParse({
      id: "x", harness: "hermes", scope: "profile", policy: "reconcilable",
    });
    expect(r.success).toBe(false);
  });

  test("a declaration targets exactly one scope level", () => {
    const fleet = DeclaredSetting.parse({
      settingId: "hermes.approvals.timeout", stationId: null, nodeId: null, value: 900,
    });
    expect(fleet.stationId).toBeNull();
    // Both set is not a level — it is two.
    expect(DeclaredSetting.safeParse({
      settingId: "x", stationId: "station_1", nodeId: "node_1", value: 1,
    }).success).toBe(false);
  });

  test("an unreadable value carries no observed value", () => {
    expect(ConfigValue.parse({ settingId: "x", readable: false, reason: "not valid YAML" }).observed)
      .toBeUndefined();
    // `readable` may not default: a reader that forgot to set it must not report success.
    expect(ConfigValue.safeParse({ settingId: "x" }).success).toBe(false);
  });

  test("observation states are closed, and include every honest non-match", () => {
    for (const state of [
      "matches", "drifted", "absent", "opted-out", "awaiting-restart", "unreadable", "out-of-scope",
    ]) {
      expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state }).success).toBe(true);
    }
    expect(ConfigObservation.safeParse({ settingId: "x", stationId: "s", state: "ok" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/contract && bun test test/harness-config.test.ts`
Expected: FAIL — `Cannot find module '../src/harness-config'`.

- [ ] **Step 3: Write the types**

```ts
// packages/contract/src/harness-config.ts
import { z } from "zod";

/**
 * Where a setting lives in its harness, and therefore what may be scoped to a
 * station. `station` is deliberately NOT a scope: for Hermes a station is a
 * profile, and for every other harness a station is a project path while the
 * config is per user — so the scope names the document, never the caller's
 * intent. Spec §6.
 */
export const ConfigScope = z.enum(["profile", "project", "user"]);
export type ConfigScope = z.infer<typeof ConfigScope>;

/**
 * What this system may do to a setting's value (spec D2).
 *
 * `additive-only` exists because a harness persists operator decisions into the
 * same file: reconciling `command_allowlist` to a declared list would delete a
 * grant an operator made minutes earlier through the harness's own UI.
 */
export const ConfigPolicy = z.enum(["reconcilable", "additive-only", "report-only"]);
export type ConfigPolicy = z.infer<typeof ConfigPolicy>;

/** One registered setting. The registry is a list of these, held by the node. */
export const ConfigSetting = z.object({
  /** Stable id used by the API, the CLI and declarations: `<harness>.<path>`. */
  id: z.string().min(1),
  harness: z.string().min(1),
  scope: ConfigScope,
  policy: ConfigPolicy,
  /**
   * Required, never defaulted. Spec F4: the two errors are not symmetric —
   * claiming a restart is needed when it is not costs a restart, while claiming
   * one is not needed when it is leaves a file saying 900 and a gateway still
   * enforcing 300.
   */
  restartToTakeEffect: z.boolean(),
});
export type ConfigSetting = z.infer<typeof ConfigSetting>;

/**
 * What the fleet wants, at exactly one level. `stationId` and `nodeId` are both
 * null for a fleet-wide declaration; setting both is refused, because two levels
 * is not a level.
 */
export const DeclaredSetting = z
  .object({
    settingId: z.string().min(1),
    stationId: z.string().nullable(),
    nodeId: z.string().nullable(),
    value: z.unknown(),
  })
  .refine((d) => !(d.stationId !== null && d.nodeId !== null), {
    message: "a declaration targets one level: station, node, or fleet (both null)",
  });
export type DeclaredSetting = z.infer<typeof DeclaredSetting>;

/**
 * What a station actually has. The NODE produces this and is told nothing about
 * what was declared — comparison is the hub's, because only the hub resolves
 * station → node → fleet precedence.
 */
export const ConfigValue = z.object({
  settingId: z.string().min(1),
  /** Absent when the key is not in the document, or when it could not be read. */
  observed: z.unknown().optional(),
  /** Required: a reader that forgot to set it must not report success. */
  readable: z.boolean(),
  reason: z.string().optional(),
});
export type ConfigValue = z.infer<typeof ConfigValue>;

/** What the hub makes of a station, once values are compared with declarations. */
export const ConfigObservation = z.object({
  settingId: z.string().min(1),
  stationId: z.string().min(1),
  declared: z.unknown().optional(),
  observed: z.unknown().optional(),
  state: z.enum([
    "matches",
    "drifted",
    "absent", // declared, and the key is not in the document
    "opted-out", // an explicit operator opt-out; spec D6
    "awaiting-restart", // written, not yet live; spec F4
    "unreadable", // the document could not be parsed — never `matches`
    "out-of-scope", // declared per-station for a non-station-scoped setting; D7
  ]),
  /** Why, whenever the state is not `matches`. Never a bare boolean. */
  reason: z.string().optional(),
});
export type ConfigObservation = z.infer<typeof ConfigObservation>;
```

- [ ] **Step 4: Export from the package index**

Add to `packages/contract/src/index.ts`, beside the other `export *` lines:

```ts
export * from "./harness-config";
```

- [ ] **Step 5: Run the tests and the suite**

Run: `cd packages/contract && bun test`
Expected: the six new tests PASS; nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add packages/contract/src/harness-config.ts packages/contract/src/index.ts \
        packages/contract/test/harness-config.test.ts
git commit -m "contract: the types a declared harness setting travels as"
```

---

### Task 2: A nesting-aware YAML scalar reader, extracted

**Files:**
- Create: `apps/node-agent/internal/descriptor/yamlscalar.go`
- Create: `apps/node-agent/internal/descriptor/yamlscalar_test.go`
- Modify: `apps/node-agent/internal/descriptor/hermes.go:264-290` (`multiplexProfiles`)

**Interfaces:**
- Consumes: nothing.
- Produces: `func yamlScalar(data []byte, section, key string) (value string, found bool)` in package `descriptor`.

**Why extract rather than add a YAML library:** `hermeslive/config.go` records the rule — *"The document is parsed to decide what to do and edited as lines to do it … re-encoding would reflow an operator's file."* `multiplexProfiles` is already a hand-rolled instance of exactly this read. One reader, used twice, beats two.

- [ ] **Step 1: Write the failing test**

```go
// apps/node-agent/internal/descriptor/yamlscalar_test.go
package descriptor

import "testing"

func TestYamlScalar(t *testing.T) {
	doc := []byte(`
# a comment
gateway:
  multiplex_profiles: true
approvals:
  mode: ask
  timeout: 900   # seconds
  command_allowlist:
    - ls
model:
  timeout: 5
`)
	cases := []struct {
		name, section, key, want string
		found                    bool
	}{
		{"a scalar in its section", "approvals", "timeout", "900", true},
		{"a comment after the value is not part of it", "approvals", "mode", "ask", true},
		{"a key in another section does not leak", "gateway", "timeout", "", false},
		{"the same key in two sections stays distinct", "model", "timeout", "5", true},
		{"a missing section", "nope", "timeout", "", false},
		{"a missing key in a present section", "approvals", "nope", "", false},
		{"a list-valued key is not a scalar", "approvals", "command_allowlist", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, found := yamlScalar(doc, c.section, c.key)
			if found != c.found || got != c.want {
				t.Fatalf("yamlScalar(%q,%q) = %q,%v; want %q,%v", c.section, c.key, got, found, c.want, c.found)
			}
		})
	}
}

func TestYamlScalarQuotedAndUnreadable(t *testing.T) {
	if got, _ := yamlScalar([]byte("approvals:\n  mode: \"ask\"\n"), "approvals", "mode"); got != "ask" {
		t.Fatalf("quotes should be trimmed, got %q", got)
	}
	// Not a parser: a document with no sections simply finds nothing. The CALLER
	// decides whether "not found" means unreadable — see hermes_config.go.
	if _, found := yamlScalar([]byte("just a line\n"), "approvals", "mode"); found {
		t.Fatal("a document with no section should find nothing")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestYamlScalar -v`
Expected: FAIL — `undefined: yamlScalar`.

- [ ] **Step 3: Write the reader**

```go
// apps/node-agent/internal/descriptor/yamlscalar.go
package descriptor

import "strings"

// yamlScalar reads `section.key` out of a YAML document as text, without a YAML
// parser and without re-encoding anything.
//
// This is the generalisation of what `hermesDescriptor.multiplexProfiles` did by
// hand, and it exists for the reason `hermeslive/config.go` records: a document
// is parsed to DECIDE and edited as LINES to DO, because re-encoding reflows an
// operator's file and loses their comments and ordering.
//
// Deliberately narrow. It reads one scalar under one top-level section, which is
// the shape every setting in the registry has. It does not read nested maps, and
// a list-valued key reports NOT FOUND rather than returning the empty remainder
// after the colon — "found, empty" and "not a scalar" must not look alike.
func yamlScalar(data []byte, section, key string) (string, bool) {
	inSection := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// An unindented line opens a new top-level section, closing any previous one.
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inSection = strings.TrimSpace(strings.SplitN(line, ":", 2)[0]) == section
			continue
		}
		if !inSection || !strings.HasPrefix(trimmed, key+":") {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(trimmed, key+":"))
		if i := strings.Index(v, "#"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		// Nothing after the colon is a nested value (a list or a map), not a
		// scalar this reader can speak for.
		if v == "" {
			return "", false
		}
		return strings.Trim(v, `"'`), true
	}
	return "", false
}
```

- [ ] **Step 4: Run the new test**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestYamlScalar -v`
Expected: PASS, all nine subtests.

- [ ] **Step 5: Rewrite `multiplexProfiles` on top of it**

Replace the body of `multiplexProfiles` (`hermes.go:264-290`) with:

```go
func (h *hermesDescriptor) multiplexProfiles() bool {
	data, err := os.ReadFile(filepath.Join(h.home, "config.yaml"))
	if err != nil {
		return false
	}
	v, found := yamlScalar(data, "gateway", "multiplex_profiles")
	return found && strings.EqualFold(v, "true")
}
```

- [ ] **Step 6: Prove the refactor changed nothing**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run 'Multiplex|RootGateway' -v`
Expected: the five existing tests in `hermes_multiplex_test.go` PASS unchanged. **If any needed editing, the extraction changed behaviour — stop and reconcile rather than adjusting the test.**

- [ ] **Step 7: Run the package and commit**

```bash
cd apps/node-agent && go test -race ./internal/descriptor/
git add internal/descriptor/yamlscalar.go internal/descriptor/yamlscalar_test.go internal/descriptor/hermes.go
git commit -m "node: one nesting-aware YAML scalar reader, used twice"
```

---

### Task 3: The `ConfigManager` interface and Hermes' registry

**Files:**
- Create: `apps/node-agent/internal/descriptor/config_manage.go`
- Create: `apps/node-agent/internal/descriptor/hermes_config.go`
- Create: `apps/node-agent/internal/descriptor/hermes_config_test.go`

**Interfaces:**
- Consumes: `yamlScalar(data []byte, section, key string) (string, bool)` from Task 2.
- Produces: `ConfigSetting` and `ConfigValue` Go structs; the `ConfigManager` interface with `ConfigSettings() []ConfigSetting` and `ObserveConfig(ctx, key string, settings []string) ([]ConfigValue, error)`; `hermesDescriptor` implementing both.

- [ ] **Step 1: Write the failing test**

```go
// apps/node-agent/internal/descriptor/hermes_config_test.go
package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hermesWithProfile writes a Hermes home with one profile whose config.yaml is
// `body`, and returns the descriptor and the station key for that profile.
func hermesWithProfile(t *testing.T, body string) (*hermesDescriptor, string) {
	t.Helper()
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewHermes(home).(*hermesDescriptor), "hermes:one"
}

func TestHermesConfigSettingsRegistry(t *testing.T) {
	h, _ := hermesWithProfile(t, "approvals:\n  timeout: 300\n")
	byID := map[string]ConfigSetting{}
	for _, s := range h.ConfigSettings() {
		byID[s.ID] = s
	}
	for _, want := range []string{
		"hermes.approvals.timeout", "hermes.approvals.mode", "hermes.approvals.command_allowlist",
	} {
		s, ok := byID[want]
		if !ok {
			t.Fatalf("registry is missing %s", want)
		}
		if s.Scope != "profile" {
			t.Errorf("%s: scope = %q, want profile", want, s.Scope)
		}
		// Spec §7: unverified, so every approvals setting assumes a restart.
		if !s.RestartToTakeEffect {
			t.Errorf("%s: restartToTakeEffect must be true while unverified", want)
		}
	}
	if got := byID["hermes.approvals.command_allowlist"].Policy; got != "additive-only" {
		t.Errorf("command_allowlist policy = %q, want additive-only (spec D2)", got)
	}
	if got := byID["hermes.approvals.timeout"].Policy; got != "reconcilable" {
		t.Errorf("timeout policy = %q, want reconcilable", got)
	}
}

func TestHermesObserveConfigReadsAValue(t *testing.T) {
	h, key := hermesWithProfile(t, "approvals:\n  mode: ask\n  timeout: 900\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || !vals[0].Readable || vals[0].Observed != "900" {
		t.Fatalf("got %+v; want one readable 900", vals)
	}
}

func TestHermesObserveConfigAbsentKeyIsReadableWithNoValue(t *testing.T) {
	h, key := hermesWithProfile(t, "approvals:\n  mode: ask\n")
	vals, _ := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if !vals[0].Readable {
		t.Fatal("a readable document with the key absent is readable")
	}
	if vals[0].Observed != nil {
		t.Fatalf("absent key must carry no value, got %v", vals[0].Observed)
	}
}

func TestHermesObserveConfigUnreadableDocumentIsNotAbsent(t *testing.T) {
	h, key := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	// Remove the file: the document cannot be read at all.
	if err := os.Remove(filepath.Join(h.home, "profiles", "one", "config.yaml")); err != nil {
		t.Fatal(err)
	}
	vals, _ := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if vals[0].Readable {
		t.Fatal("a document that cannot be read must report readable=false")
	}
	if vals[0].Reason == "" {
		t.Fatal("unreadable must carry a reason")
	}
}

func TestHermesObserveConfigRefusesTheCompositeRoot(t *testing.T) {
	// `workspaceFor("hermes")` returns the HOME, not a profile. Reading the home's
	// config.yaml and reporting it as a profile's value would attribute a wrong
	// readout to the wrong station, so the root is refused by name (spec §6).
	h, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	_, err := h.ObserveConfig(context.Background(), "hermes", []string{"hermes.approvals.timeout"})
	if err == nil || !strings.Contains(err.Error(), "composite root") {
		t.Fatalf("the composite root must be refused, got %v", err)
	}
}

func TestHermesObserveConfigRefusesAnUnregisteredSetting(t *testing.T) {
	h, key := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	_, err := h.ObserveConfig(context.Background(), key, []string{"hermes.model.api_key"})
	if err == nil || !strings.Contains(err.Error(), "hermes.model.api_key") {
		t.Fatalf("an unregistered setting must be refused by name, got %v", err)
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestHermesConfig -v`
Expected: FAIL — `h.ConfigSettings undefined`.

- [ ] **Step 3: Write the interface**

```go
// apps/node-agent/internal/descriptor/config_manage.go
package descriptor

import "context"

// ConfigSetting is one registered harness setting. Mirrors the contract's
// `ConfigSetting`; the JSON tags MUST match it exactly.
type ConfigSetting struct {
	ID                  string `json:"id"`
	Harness             string `json:"harness"`
	Scope               string `json:"scope"`  // "profile" | "project" | "user"
	Policy              string `json:"policy"` // "reconcilable" | "additive-only" | "report-only"
	RestartToTakeEffect bool   `json:"restartToTakeEffect"`
}

// ConfigValue is what a station actually has for one setting.
//
// There is deliberately no `declared` field and no "drifted" flag: the node is
// not told what the fleet wants, so it cannot and must not decide whether a
// value is drift. Only the hub resolves station → node → fleet precedence.
type ConfigValue struct {
	SettingID string `json:"settingId"`
	Observed  any    `json:"observed,omitempty"`
	// Readable is false when the document could not be read or parsed. It is a
	// field rather than an inference because an unreadable document must never
	// look like a document whose key is absent.
	Readable bool   `json:"readable"`
	Reason   string `json:"reason,omitempty"`
}

// ConfigManager is an OPTIONAL interface for descriptors that can read a
// registered subset of their harness's own configuration.
//
// `config.manage` is advertised in Detect output ONLY when the descriptor
// implements this and the station's WorkspacePath is absolute — the same gate
// `skills.manage` uses.
//
// Writing is NOT in this interface yet, by design: plan 1 of this design reads
// only, so that the registry and the scope rules are proven while the worst
// available bug is a wrong readout.
type ConfigManager interface {
	// ConfigSettings is this harness's registry: every setting it can manage.
	// An id absent here is refused by name, never read speculatively.
	ConfigSettings() []ConfigSetting

	// ObserveConfig reads the current values for `settings` on the station
	// `key`. It never writes and never restarts.
	ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error)
}
```

- [ ] **Step 4: Write Hermes' registry and reader**

```go
// apps/node-agent/internal/descriptor/hermes_config.go
package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// hermesConfigRegistry is the whole set of Hermes settings this system manages.
//
// A list, not a pattern (spec D1). `approvals.*` is here because a prompt that
// expires before a human can answer is what this design came from; everything
// else Hermes has stays the operator's, reachable through the raw Config panel.
//
// Every entry assumes a restart is needed. Hermes documents hot-reload for
// `model.context_length` and `compression.*` and a restart for "API keys and
// tool/skill config"; `approvals.*` is in neither list, so this is UNVERIFIED and
// the safe direction is to assume yes — see spec §7.
var hermesConfigRegistry = []ConfigSetting{
	{ID: "hermes.approvals.timeout", Harness: "hermes", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true},
	{ID: "hermes.approvals.mode", Harness: "hermes", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true},
	{ID: "hermes.approvals.command_allowlist", Harness: "hermes", Scope: "profile", Policy: "additive-only", RestartToTakeEffect: true},
}

// hermesConfigPath maps a registered setting id to the YAML section and key it
// lives under. Separate from the registry because the registry is the wire
// contract and this is how to find the value — two different facts.
var hermesConfigPath = map[string][2]string{
	"hermes.approvals.timeout":           {"approvals", "timeout"},
	"hermes.approvals.mode":              {"approvals", "mode"},
	"hermes.approvals.command_allowlist": {"approvals", "command_allowlist"},
}

func (h *hermesDescriptor) ConfigSettings() []ConfigSetting {
	out := make([]ConfigSetting, len(hermesConfigRegistry))
	copy(out, hermesConfigRegistry)
	return out
}

func (h *hermesDescriptor) ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Refuse the whole request on an unregistered id rather than returning a
	// partial answer: a caller that asked for four settings and silently got
	// three cannot tell which.
	for _, id := range settings {
		if _, ok := hermesConfigPath[id]; !ok {
			return nil, fmt.Errorf("config: %s is not a setting this harness manages", id)
		}
	}

	// workspaceFor is the EXISTING key→directory resolver (hermes.go). A second
	// one is how two readers come to disagree about which profile a station is.
	//
	// It returns h.home for the bare key "hermes" — the COMPOSITE root, which has
	// no profile of its own. A profile-scoped setting declared against the root is
	// refused rather than read from the home or fanned out to every child
	// (spec §6).
	if key == "hermes" {
		return nil, fmt.Errorf("config: %s is the composite root, which has no profile of its own — declare this per profile, or at node or fleet level", key)
	}
	dir, err := h.workspaceFor(key)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "config.yaml")
	data, readErr := os.ReadFile(path)

	out := make([]ConfigValue, 0, len(settings))
	for _, id := range settings {
		if readErr != nil {
			// Unreadable, which is NOT the same as a key that is absent.
			out = append(out, ConfigValue{SettingID: id, Readable: false, Reason: readErr.Error()})
			continue
		}
		where := hermesConfigPath[id]
		v, found := yamlScalar(data, where[0], where[1])
		cv := ConfigValue{SettingID: id, Readable: true}
		if found {
			cv.Observed = v
		}
		out = append(out, cv)
	}
	return out, nil
}
```

**Note for the implementer:** `workspaceFor(key)` is the existing resolver, at `hermes.go:327`. It maps `hermes:<name>` to `<home>/profiles/<name>` and the bare key `hermes` to the home itself. **Do not add a second key→directory resolver** — a second one is how two readers come to disagree about which profile a station is.

- [ ] **Step 5: Run the test**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestHermesConfig -v`
Expected: PASS, six tests.

- [ ] **Step 6: Mutation-test the unreadable case**

Temporarily change `Readable: false` to `Readable: true` in the `readErr != nil` branch and re-run. Expected: `TestHermesObserveConfigUnreadableDocumentIsNotAbsent` FAILS. Revert. This is the test that matters most — an unreadable document reporting as agreeing is the failure this whole design exists to end.

- [ ] **Step 7: Commit**

```bash
cd apps/node-agent && go test -race ./internal/descriptor/
git add internal/descriptor/config_manage.go internal/descriptor/hermes_config.go internal/descriptor/hermes_config_test.go
git commit -m "node: Hermes reports its approvals settings, and never guesses one"
```

---

### Task 4: Advertise `config.manage`, and the broker verb

**Files:**
- Modify: `apps/node-agent/internal/descriptor/registry.go:36-52` (the `DetectAll` capability block)
- Modify: `apps/node-agent/internal/descriptor/handler.go`
- Test: `apps/node-agent/internal/descriptor/registry_test.go`, `handler_test.go`

**Interfaces:**
- Consumes: `ConfigManager` from Task 3.
- Produces: the `config.manage` capability string on qualifying stations; a `config.observe` broker verb taking `{stationKey, settings[]}` and returning `{values: ConfigValue[]}`.

- [ ] **Step 1: Write the failing tests**

```go
// append to apps/node-agent/internal/descriptor/registry_test.go
func TestDetectAllAdvertisesConfigManage(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := NewRegistry()
	reg.Register(NewHermes(home, ""))

	// Off by default: advertising a capability the operator has not enabled is
	// how the console offers an action that then refuses.
	for _, s := range reg.DetectAll() {
		for _, c := range s.Capabilities {
			if c == "config.manage" {
				t.Fatal("config.manage must not be advertised before it is enabled")
			}
		}
	}

	reg.EnableConfigManagement()
	found := false
	for _, s := range reg.DetectAll() {
		for _, c := range s.Capabilities {
			if c == "config.manage" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("config.manage should be advertised on a Hermes profile station once enabled")
	}
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/node-agent && go test ./internal/descriptor/ -run TestDetectAllAdvertisesConfigManage -v`
Expected: FAIL — `reg.EnableConfigManagement undefined`.

- [ ] **Step 3: Add the gate to the registry**

In `registry.go`, add the field and setter beside `pluginManagement`:

```go
	configManagement bool
```

```go
// EnableConfigManagement is called at startup only when the node's operator
// configuration permits reading managed settings. Detection then advertises
// config.manage on stations whose descriptor implements ConfigManager.
func (r *Registry) EnableConfigManagement() { r.configManagement = true }
```

And inside `DetectAll`'s per-station loop, beside the `skills.manage` block:

```go
			_, configurable := d.(ConfigManager)
			...
				if r.configManagement && configurable && station.WorkspacePath != nil && filepath.IsAbs(*station.WorkspacePath) {
					station.Capabilities = append(append([]string(nil), station.Capabilities...), "config.manage")
				}
```

- [ ] **Step 4: Add the broker verb**

In `handler.go`, beside the existing skills verbs:

```go
case "config.observe":
	var req struct {
		StationKey string   `json:"stationKey"`
		Settings   []string `json:"settings"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, fmt.Errorf("config.observe: %w", err)
	}
	d, err := h.reg.For(req.StationKey)
	if err != nil {
		return nil, err
	}
	cm, ok := d.(ConfigManager)
	if !ok {
		return nil, fmt.Errorf("config.observe: %s does not manage configuration", d.Harness())
	}
	values, err := cm.ObserveConfig(ctx, req.StationKey, req.Settings)
	if err != nil {
		return nil, err
	}
	return map[string]any{"values": values}, nil
```

**Note:** match the surrounding handler's own idiom for unmarshalling and returning — if neighbouring verbs use a typed response struct rather than `map[string]any`, use that. The shape on the wire is `{"values": [...]}` either way.

- [ ] **Step 5: Wire the operator switch**

In `apps/node-agent/cmd/agentpod-node/registry.go`, after the descriptors are registered, mirror how plugin management is enabled from config:

```go
	if cfg.ConfigManagement {
		reg.EnableConfigManagement()
	}
```

Add `ConfigManagement bool` to `internal/config.Config` with the same JSON key style as the existing flags, defaulting false.

- [ ] **Step 6: Run the package**

Run: `cd apps/node-agent && go test -race ./internal/descriptor/ ./cmd/agentpod-node/`
Expected: PASS, including the new capability test.

- [ ] **Step 7: Commit**

```bash
git add internal/descriptor/registry.go internal/descriptor/registry_test.go \
        internal/descriptor/handler.go internal/config cmd/agentpod-node/registry.go
git commit -m "node: config.manage, off until an operator enables it"
```

---

### Task 5: Declared state in the hub

**Files:**
- Create: `apps/hub/src/db/schema/harness-config.ts`
- Modify: `apps/hub/src/db/schema/index.ts`
- Create: one generated migration under `apps/hub/src/db/drizzle-migrations/`
- Modify: `apps/hub/src/db/tenant-scope.ts` — register the table in `TENANT_SCOPED_TABLES`. **Not optional:** `tenantScope()` throws `TenantIsolationError` for any table absent from that list, so the store does not function without it, and an existing guard test enforces it.
- Test: `apps/hub/tests/unit/harness-config-store.test.ts`

**Interfaces:**
- Consumes: the contract's `DeclaredSetting` (Task 1).
- Produces: table `declared_harness_config`; `declare()`, `undeclare()`, and
  `resolveFor(stationId, nodeId, tenantId): Promise<Record<string, Resolved>>` where
  `Resolved = { value: unknown; level: "station" | "node" | "fleet" }`, in
  `apps/hub/src/services/harness-config.ts` (the store half; comparison is Task 6).

  **`level` is load-bearing, not informational.** Task 6 refuses a station-scoped
  declaration of a `user`-scoped setting, and it can only know the declaration was made
  at station level if this function says so. Returning bare values makes that refusal
  unreachable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub/tests/unit/harness-config-store.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { declare, undeclare, resolveFor } from "../../src/services/harness-config";

const SETTING = "hermes.approvals.timeout";
// The fixture tenant the other hub unit tests use; `tenantId` is REQUIRED on every
// call and is never made optional to suit a test (a cross-tenant write is the most
// expensive defect class in this repo).
// `tenants.id` is CHECK-constrained to `fleet_<20 hex>` — an invented id like
// "tnt_test" fails the constraint AND `tenantScope`'s `assertTenantId`. Use the
// bootstrap tenant the other hub unit tests use.
const TENANT = BOOTSTRAP_TENANT_ID;
const WHO = "usr_test";

const fleet = { settingId: SETTING, stationId: null, nodeId: null, tenantId: TENANT, declaredBy: WHO };
const atNode = { ...fleet, nodeId: "node_1" };
const atStation = { ...fleet, stationId: "station_a" };
const resolved = async (station: string) => (await resolveFor(station, "node_1", TENANT))[SETTING];

describe("declared harness config", () => {
  beforeEach(async () => { /* truncate declared_harness_config — follow TESTING.md's helper */ });

  test("the most specific declaration wins: station over node over fleet", async () => {
    await declare({ ...fleet, value: 300 });
    expect(await resolved("station_a")).toEqual({ value: 300, level: "fleet" });

    await declare({ ...atNode, value: 600 });
    expect(await resolved("station_a")).toEqual({ value: 600, level: "node" });

    await declare({ ...atStation, value: 900 });
    expect(await resolved("station_a")).toEqual({ value: 900, level: "station" });

    // A sibling on the same node still gets the node's value, not the station's.
    expect(await resolved("station_b")).toEqual({ value: 600, level: "node" });
  });

  test("declaring twice at one level replaces rather than duplicates", async () => {
    await declare({ ...fleet, value: 300 });
    await declare({ ...fleet, value: 900 });
    expect(await resolved("station_a")).toEqual({ value: 900, level: "fleet" });
  });

  test("undeclaring a level falls back to the next one out", async () => {
    await declare({ ...fleet, value: 300 });
    await declare({ ...atStation, value: 900 });
    await undeclare({ ...atStation });
    expect(await resolved("station_a")).toEqual({ value: 300, level: "fleet" });
  });

  test("nothing declared resolves to nothing — never to a default", async () => {
    expect(await resolveFor("station_a", "node_1", TENANT)).toEqual({});
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/unit/harness-config-store.test.ts`
Expected: FAIL — cannot resolve `../../src/services/harness-config`.

- [ ] **Step 3: Write the schema**

```ts
// apps/hub/src/db/schema/harness-config.ts
import { pgTable, text, jsonb, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";

/**
 * What the fleet wants a harness setting to be.
 *
 * One row per (setting, level). A level is a station, a node, or the fleet —
 * and exactly one of `stationId`/`nodeId` is set, or neither for the fleet.
 * Two set is not a level, which the contract's `DeclaredSetting` refuses and
 * the unique indexes below cannot express, so the service checks it.
 *
 * This table says nothing about what any station HAS. Observations are read
 * live from the node and never cached here: a cached observation is a claim
 * about a machine that may have changed since, which is the class of bug this
 * whole design exists to end.
 */
export const declaredHarnessConfig = pgTable(
  "declared_harness_config",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().references(() => tenants.id, { onDelete: "cascade" }),
    settingId: text("setting_id").notNull(),
    /** Null for a node-level or fleet-level declaration. */
    stationId: text("station_id"),
    /** Null for a station-level or fleet-level declaration. */
    nodeId: text("node_id"),
    /** The declared value, as the harness would hold it. */
    value: jsonb("value").notNull(),
    declaredBy: text("declared_by").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    // One declaration per level. Postgres treats NULLs as distinct in a unique
    // index, so the fleet level needs its own partial index below rather than
    // relying on this one.
    perStation: uniqueIndex("declared_cfg_station").on(t.tenantId, t.settingId, t.stationId),
    perNode: uniqueIndex("declared_cfg_node").on(t.tenantId, t.settingId, t.nodeId),
    bySetting: index("declared_cfg_setting").on(t.tenantId, t.settingId),
  }),
);
```

Export it from `apps/hub/src/db/schema/index.ts`.

**The fleet level needs a partial unique index** that drizzle's builder cannot express; add it by hand in the generated migration:

```sql
CREATE UNIQUE INDEX declared_cfg_fleet
  ON declared_harness_config (tenant_id, setting_id)
  WHERE station_id IS NULL AND node_id IS NULL;
```

- [ ] **Step 4: Generate and inspect the migration**

Run the repo's drizzle generate step, then **read the generated SQL** and add the partial index above. A generated migration nobody read is how a constraint goes missing.

- [ ] **Step 5: Write the store**

```ts
// apps/hub/src/services/harness-config.ts
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { declaredHarnessConfig } from "../db/schema/harness-config";
import { newId } from "../ids";

export interface Level { stationId: string | null; nodeId: string | null }

/** Two levels is not a level. Checked here because no index can express it. */
function assertOneLevel(l: Level): void {
  if (l.stationId !== null && l.nodeId !== null) {
    throw new Error("a declaration targets one level: station, node, or fleet");
  }
}

export async function declare(
  input: Level & { settingId: string; value: unknown; tenantId: string; declaredBy: string },
): Promise<void> {
  assertOneLevel(input);
  // Delete-then-insert in a transaction, NOT `onConflictDoUpdate`.
  //
  // An earlier draft of this plan used `onConflictDoUpdate` targeting the
  // `(tenantId, settingId, stationId)` index. That is broken for two of the three
  // levels: Postgres treats NULL as distinct, so `declared_cfg_station` only
  // constrains rows with a non-null `stationId`, and a node-level or fleet-level
  // declaration made twice would never conflict — it would INSERT A DUPLICATE
  // instead of replacing. `ON CONFLICT` can target only one index, so no single
  // call covers all three levels.
  //
  // Known cost, accepted: a replacement gets a fresh `id` and a fresh
  // `createdAt`, so "first declared at" does not survive a replace. Nothing reads
  // it today. If an audit ever needs it, read the row before deleting and carry
  // the original `createdAt` forward.
  await db.transaction(async (tx) => {
    await tx.delete(declaredHarnessConfig).where(levelWhere(input));
    await tx.insert(declaredHarnessConfig).values({
      id: newId("dcfg"),
      tenantId: input.tenantId,
      settingId: input.settingId,
      stationId: input.stationId,
      nodeId: input.nodeId,
      value: input.value,
      declaredBy: input.declaredBy,
    });
  });
}

/**
 * The WHERE that identifies exactly one level, with NULL compared as NULL.
 *
 * Shared by `declare` and `undeclare` so the two cannot disagree about which row
 * a level names — the disagreement that `onConflictDoUpdate` hid.
 */
function levelWhere(l: Level & { settingId: string; tenantId: string }) {
  return and(
    eq(declaredHarnessConfig.tenantId, l.tenantId),
    eq(declaredHarnessConfig.settingId, l.settingId),
    l.stationId === null ? isNull(declaredHarnessConfig.stationId) : eq(declaredHarnessConfig.stationId, l.stationId),
    l.nodeId === null ? isNull(declaredHarnessConfig.nodeId) : eq(declaredHarnessConfig.nodeId, l.nodeId),
  );
}

export async function undeclare(input: Level & { settingId: string; tenantId: string }): Promise<void> {
  assertOneLevel(input);
  await db.delete(declaredHarnessConfig).where(
    and(
      eq(declaredHarnessConfig.tenantId, input.tenantId),
      eq(declaredHarnessConfig.settingId, input.settingId),
      input.stationId === null ? isNull(declaredHarnessConfig.stationId) : eq(declaredHarnessConfig.stationId, input.stationId),
      input.nodeId === null ? isNull(declaredHarnessConfig.nodeId) : eq(declaredHarnessConfig.nodeId, input.nodeId),
    ),
  );
}

/**
 * Every setting declared for this station, most specific declaration winning:
 * station, then its node, then the fleet.
 *
 * Returns only what was declared. A setting nobody declared is ABSENT from the
 * result rather than carrying a default — this system has no opinion about a
 * setting the operator never mentioned.
 */
export async function resolveFor(
  stationId: string,
  nodeId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(declaredHarnessConfig)
    .where(eq(declaredHarnessConfig.tenantId, tenantId));

  const out: Record<string, unknown> = {};
  const rank = (r: typeof rows[number]) =>
    r.stationId === stationId ? 3 : r.nodeId === nodeId ? 2 : r.stationId === null && r.nodeId === null ? 1 : 0;

  const best: Record<string, number> = {};
  for (const r of rows) {
    const score = rank(r);
    if (score === 0) continue; // another station's or another node's
    if ((best[r.settingId] ?? 0) < score) {
      best[r.settingId] = score;
      out[r.settingId] = r.value;
    }
  }
  return out;
}
```

**Note:** `tenantId` and `declaredBy` are required on every call — **do not make them optional to suit a test.** Every hub query is tenant-scoped and an optional tenant is a cross-tenant write. Use `BOOTSTRAP_TENANT_ID`: `tenants.id` is CHECK-constrained to `fleet_<20 hex>`, so an invented id is rejected twice over.

**Reading the generated migration is a step, not a formality.** `drizzle-kit generate` re-emits DDL for any table whose snapshot is missing — migrations 0083/0084 are hand-written and have none — so it will offer `CREATE`/`ALTER` for tables already live. Strip those; keep only this table and the hand-added partial index. Committing them would break every environment where 0084 has already run.

- [ ] **Step 6: Run the tests**

Run: `cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/unit/harness-config-store.test.ts`
Expected: PASS, five tests.

- [ ] **Step 7: Commit**

```bash
git add apps/hub/src/db/schema/harness-config.ts apps/hub/src/db/schema/index.ts \
        apps/hub/src/db/drizzle-migrations apps/hub/src/services/harness-config.ts \
        apps/hub/tests/unit/harness-config-store.test.ts
git commit -m "hub: what the fleet wants a harness setting to be"
```

---

### Task 6: Compare, and name every honest non-match

**Files:**
- Modify: `apps/hub/src/services/harness-config.ts`
- Test: `apps/hub/tests/unit/harness-config-compare.test.ts`

**Interfaces:**
- Consumes: `resolveFor` (Task 5); `ConfigValue`, `ConfigObservation`, `ConfigSetting` (Task 1).
- Produces: `compare(args: { stationId, declared, values, settings }): ConfigObservation[]`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub/tests/unit/harness-config-compare.test.ts
import { describe, test, expect } from "bun:test";
import { compare } from "../../src/services/harness-config";

const SETTING = {
  id: "hermes.approvals.timeout", harness: "hermes", scope: "profile" as const,
  policy: "reconcilable" as const, restartToTakeEffect: true,
};
const base = { stationId: "station_a", settings: [SETTING] };

describe("comparing a station against the declaration", () => {
  test("equal values match", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("different values drift, and the reason names both", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true, observed: "300" }] });
    expect(o.state).toBe("drifted");
    expect(o.reason).toContain("900");
    expect(o.reason).toContain("300");
  });

  test("declared values compare by value, not by type — 900 and \"900\" agree", () => {
    // The node reads YAML as text; a declaration arrives as JSON. Treating these
    // as different would report drift on every numeric setting, forever.
    const [o] = compare({ ...base, declared: { [SETTING.id]: 900 }, values: [{ settingId: SETTING.id, readable: true, observed: "900" }] });
    expect(o.state).toBe("matches");
  });

  test("declared but absent from the document is `absent`, not `drifted`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: true }] });
    expect(o.state).toBe("absent");
  });

  test("an unreadable document is `unreadable` — never `matches` and never `absent`", () => {
    const [o] = compare({ ...base, declared: { [SETTING.id]: "900" }, values: [{ settingId: SETTING.id, readable: false, reason: "no such file" }] });
    expect(o.state).toBe("unreadable");
    expect(o.reason).toContain("no such file");
  });

  test("a setting nobody declared is not reported at all", () => {
    expect(compare({ ...base, declared: {}, values: [{ settingId: SETTING.id, readable: true, observed: "300" }] })).toEqual([]);
  });

  test("a station-scoped declaration for a user-scoped setting is out-of-scope", () => {
    const userScoped = { ...SETTING, id: "openclaw.hooks.allowConversationAccess", harness: "openclaw", scope: "user" as const };
    const [o] = compare({
      stationId: "station_a", settings: [userScoped],
      declared: { [userScoped.id]: true }, values: [{ settingId: userScoped.id, readable: true, observed: true }],
      declaredAtStationLevel: new Set([userScoped.id]),
    });
    expect(o.state).toBe("out-of-scope");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && DATABASE_URL=… bun test tests/unit/harness-config-compare.test.ts`
Expected: FAIL — `compare` is not exported.

- [ ] **Step 3: Implement `compare`**

Append to `apps/hub/src/services/harness-config.ts`:

```ts
import type { ConfigObservation, ConfigSetting, ConfigValue } from "@agentpod/contract";

/**
 * Compare a station's values with what was declared for it.
 *
 * Only settings that were DECLARED are reported: this system has no opinion
 * about a setting nobody mentioned, and reporting one would make the drift list
 * a list of every setting in the fleet.
 */
export function compare(args: {
  stationId: string;
  values: ConfigValue[];
  settings: ConfigSetting[];
  /**
   * The resolution from `resolveFor`: value AND the level it came from. The level
   * is load-bearing — `out-of-scope` fires only when the winning declaration was
   * made at STATION level for a setting whose document is not per-station.
   */
  declared: Record<string, { value: unknown; level: "station" | "node" | "fleet" }>;
}): ConfigObservation[] {
  const byId = new Map(args.settings.map((s) => [s.id, s]));
  const out: ConfigObservation[] = [];

  for (const v of args.values) {
    if (!(v.settingId in args.declared)) continue;
    const { value: declared, level } = args.declared[v.settingId]!;
    const setting = byId.get(v.settingId);
    const row = { settingId: v.settingId, stationId: args.stationId, declared, observed: v.observed };

    // Scope first: a declaration that cannot be honoured is not drift, and
    // saying "drifted" would invite an apply that must then refuse.
    if (setting && setting.scope !== "profile" && level === "station") {
      out.push({ ...row, state: "out-of-scope",
        reason: `${v.settingId} is ${setting.scope}-scoped: declaring it for one station would change its siblings on the same host` });
      continue;
    }
    if (!v.readable) {
      out.push({ ...row, observed: undefined, state: "unreadable",
        reason: v.reason ?? "the document could not be read" });
      continue;
    }
    if (v.observed === undefined) {
      out.push({ ...row, state: "absent", reason: `declared, and the key is not in the document` });
      continue;
    }
    if (sameValue(declared, v.observed)) {
      out.push({ ...row, state: "matches" });
      continue;
    }
    out.push({ ...row, state: "drifted",
      reason: `declared ${JSON.stringify(declared)}, observed ${JSON.stringify(v.observed)}` });
  }
  return out;
}

/**
 * Do a declaration and an observation agree?
 *
 * Compared as text, because the node reads YAML as text while a declaration
 * arrives as JSON: treating `900` and `"900"` as different would report drift on
 * every numeric setting forever, and a drift report that is always wrong is one
 * nobody reads.
 */
function sameValue(declared: unknown, observed: unknown): boolean {
  if (declared === null || declared === undefined) return declared === observed;
  if (typeof declared === "object" || typeof observed === "object") {
    return JSON.stringify(declared) === JSON.stringify(observed);
  }
  return String(declared) === String(observed);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL=… bun test tests/unit/harness-config-compare.test.ts`
Expected: PASS, seven tests.

- [ ] **Step 5: Mutation-test the two states that must not collapse**

Change the `!v.readable` branch to fall through to the `absent` branch and re-run: the `unreadable` test must FAIL. Then change `sameValue` to `declared === observed` and re-run: the `900`/`"900"` test must FAIL. Revert both. These two are the states whose collapse would make the whole report dishonest.

- [ ] **Step 6: Commit**

```bash
git add apps/hub/src/services/harness-config.ts apps/hub/tests/unit/harness-config-compare.test.ts
git commit -m "hub: compare a station with the declaration, and name the mismatch"
```

---

### Task 7: The hub's routes

**Files:**
- Create: `apps/hub/src/routes/harness-config.ts`
- Modify: the hub's route registration (wherever `skills` and `plugins` routes are mounted)
- Test: `apps/hub/tests/unit/harness-config-routes.test.ts`

**Interfaces:**
- Consumes: `declare`, `undeclare`, `resolveFor`, `compare` (Tasks 5-6); the broker's `config.observe` verb (Task 4).
- Produces: `GET /api/fleet/config/settings`, `GET|PUT|DELETE /api/fleet/config/declared`, `GET /api/stations/:stationId/config`, `GET /api/fleet/config/drift`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/hub/tests/unit/harness-config-routes.test.ts
import { describe, test, expect } from "bun:test";
// Follow the shape of apps/hub/src/routes/station-acp.test.ts for app construction
// and auth fixtures — do not invent a second harness for route tests.

describe("harness config routes", () => {
  test("an agent-kind token is refused on every route", async () => {
    // The operator API refuses non-human principals at the door; these routes
    // declare fleet policy and are no exception.
    for (const path of ["/api/fleet/config/settings", "/api/fleet/config/drift"]) {
      const res = await appFetch(path, { token: agentToken });
      expect(res.status).toBe(403);
    }
  });

  test("PUT declared refuses a declaration naming two levels", async () => {
    const res = await appFetch("/api/fleet/config/declared", {
      method: "PUT", token: humanToken,
      body: { settingId: "hermes.approvals.timeout", stationId: "station_a", nodeId: "node_1", value: 900 },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("one level");
  });

  test("a station whose node is offline reports unreadable, not matches", async () => {
    // The broker cannot reach an offline node. A route that returned `matches`
    // here would report agreement it never observed.
    const res = await appFetch(`/api/stations/${offlineStationId}/config`, { token: humanToken });
    const body = await res.json();
    expect(res.status).toBe(200);
    for (const o of body.observations) expect(o.state).toBe("unreadable");
  });

  test("drift lists only stations that disagree", async () => {
    const res = await appFetch("/api/fleet/config/drift", { token: humanToken });
    const body = await res.json();
    for (const o of body.observations) expect(o.state).not.toBe("matches");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/hub && DATABASE_URL=… bun test tests/unit/harness-config-routes.test.ts`
Expected: FAIL — the routes 404.

- [ ] **Step 3: Write the routes**

Follow `apps/hub/src/routes/station-acp.ts` for the Hono router shape, the auth middleware and the station-ownership check. Four handlers:

- `GET /api/fleet/config/settings` — the union of every online node's `ConfigSettings()`, de-duplicated by `id`. A node that cannot be reached is **named in a `unreachableNodes` array** rather than omitted silently.
- `GET /api/fleet/config/declared` — every declaration for the tenant, with optional
  `?station=<id>` and `?node=<id>` filters. The filters exist because `fleet config show
  --node` already calls it that way; without them that flag silently returns the whole
  fleet's declarations.
- `PUT /api/fleet/config/declared` — validate with the contract's `DeclaredSetting`, then `declare()`. A `settingId` that no node's registry knows is refused `400` with `UNKNOWN_SETTING` and the id.
- `DELETE /api/fleet/config/declared` — `undeclare()`.
- `GET /api/stations/:stationId/config` — `resolveFor` + broker `config.observe` + `compare`. A broker failure (offline node, timeout) yields `ConfigValue{readable:false, reason}` for every requested setting, so the route still answers 200 with honest `unreadable` rows.
- `GET /api/fleet/config/drift` — the same, fanned across every station with `config.manage`, filtered to `state !== "matches"`. Carries `stationsUnreachable` for the ones that could not be asked, for the same reason the project rollup admits a board it could not read.

- [ ] **Step 4: Run the tests**

Run: `cd apps/hub && DATABASE_URL=… bun test tests/unit/harness-config-routes.test.ts`
Expected: PASS, four tests.

- [ ] **Step 5: Commit**

```bash
git add apps/hub/src/routes/harness-config.ts apps/hub/tests/unit/harness-config-routes.test.ts apps/hub/src/index.ts
git commit -m "hub: declare a setting, and ask a station what it has"
```

---

### Task 8: `fleet config`, and the page that documents it

**Files:**
- Create: `apps/node-agent/cmd/agentpod-fleet/config.go`
- Modify: `apps/node-agent/cmd/agentpod-fleet/fleet.go`, `help.go`
- Create: `docs-site/src/content/docs/use/config.md`
- Modify: `docs-site/astro.config.mjs`

**Interfaces:**
- Consumes: the routes from Task 7.
- Produces: `fleet config settings|show|set|unset|drift`.

- [ ] **Step 1: Write the verb**

```go
// apps/node-agent/cmd/agentpod-fleet/config.go
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
)

const configUsage = `usage:
  fleet config settings                          every setting the fleet can declare
  fleet config show   [--station ID | --node ID] declared vs observed, with state
  fleet config set    SETTING_ID --value V [--station ID | --node ID]
  fleet config unset  SETTING_ID [--station ID | --node ID]
  fleet config drift                             every station whose value differs

` + "`set` records a DECLARATION; it does not write to a station. Writing is a\n" +
	"separate reviewed operation, and is not in this release."

// fleetConfig declares what a harness setting should be, and reports what each
// station actually has.
//
// `set` deliberately does not write to a station. The gap between declaring and
// applying is the design, not an omission: a harness rewrites its own config and
// persists operator decisions into it, so nothing here moves a file unasked.
func fleetConfig(args []string) {
	if len(args) == 0 || helpRequested(args) {
		fmt.Println(configUsage)
		if len(args) == 0 {
			os.Exit(2)
		}
		return
	}
	const base = "/api/fleet/config"
	switch args[0] {
	case "settings":
		fleetGet(base+"/settings", args)
	case "drift":
		fleetGet(base+"/drift", args)
	case "show":
		fs := flag.NewFlagSet("fleet config show", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[1:])
		if *station != "" {
			fleetGet("/api/stations/"+url.PathEscape(*station)+"/config", args)
			return
		}
		q := base + "/declared"
		if *node != "" {
			q += "?node=" + url.QueryEscape(*node)
		}
		fleetGet(q, args)
	case "set":
		id := needArg(args, 1, "set", configUsage)
		fs := flag.NewFlagSet("fleet config set", flag.ExitOnError)
		value := fs.String("value", "", "the declared value")
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		if *value == "" {
			fmt.Fprintf(os.Stderr, "set requires --value\n\n%s\n", configUsage)
			os.Exit(2)
		}
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "value": *value,
			"stationId": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodPut, base+"/declared", bytes.NewReader(body), "application/json")
	case "unset":
		id := needArg(args, 1, "unset", configUsage)
		fs := flag.NewFlagSet("fleet config unset", flag.ExitOnError)
		station := fs.String("station", "", "station ID")
		node := fs.String("node", "", "node ID")
		fs.Parse(args[2:])
		body, _ := json.Marshal(map[string]any{
			"settingId": id, "stationId": nullable(*station), "nodeId": nullable(*node),
		})
		fleetSkillRequest(http.MethodDelete, base+"/declared", bytes.NewReader(body), "application/json")
	default:
		fmt.Fprintln(os.Stderr, configUsage)
		os.Exit(2)
	}
}

// nullable turns an unset flag into a JSON null, so "not this level" and "the
// empty string" cannot arrive looking alike.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
```

- [ ] **Step 2: Dispatch it and add the help line**

In `fleet.go`'s switch: `case "config": fleetConfig(args[1:])`.
In `help.go`, beside `fleet grants`:

```
  fleet config …             what a harness setting should be, and what it is
```

- [ ] **Step 3: Write the published page**

Create `docs-site/src/content/docs/use/config.md` with frontmatter `title: Declared harness settings` and a description, covering: what a declaration is; that `set` does not write; the three policies; why a station is not a config scope on five of six harnesses; and the states a station can report. Add a sidebar entry under **Use it** in `docs-site/astro.config.mjs`.

**The docs guard will check this page.** `apps/hub/tests/unit/docs-claims.test.ts` asserts every `` `fleet <verb>` `` named in a published page is a registered command — so `fleet config` must be dispatched (Step 2) before the page naming it can pass.

- [ ] **Step 4: Run the guard and the build**

```bash
cd apps/hub && DATABASE_URL=… bun test tests/unit/docs-claims.test.ts
cd ../../docs-site && npm run build
```
Expected: both PASS. `deploy-docs` does not run on a pull request, so this local build is the only gate on the page.

- [ ] **Step 5: Commit**

```bash
git add apps/node-agent/cmd/agentpod-fleet/config.go apps/node-agent/cmd/agentpod-fleet/fleet.go \
        apps/node-agent/cmd/agentpod-fleet/help.go docs-site/src/content/docs/use/config.md \
        docs-site/astro.config.mjs
git commit -m "fleet: declare a harness setting, and see what each station has"
```

---

## Self-review

**Spec coverage.** §5 contract types → Task 1. §5 node interface → Tasks 2-4 (read half only; `PlanConfig`/`ApplyConfig` are Plan 2 and named as such). §5 hub declared state and precedence → Task 5. §5 comparison and states → Task 6. §6 scope refusal → Task 6 (`out-of-scope`) and Task 7 (`400` on a two-level declaration). §7 first settings → Task 3 (the three `approvals.*`; the four folded-in settings are Plan 2). §8 CLI and API → Tasks 7-8; **console is Plan 2** and the plan says so. §9 refusals → `UNKNOWN_SETTING` (Tasks 3, 7), `OUT_OF_SCOPE` (Task 6), `UNREADABLE` (Tasks 3, 6, 7). §10 tests 1-8 → the ones about reading and comparing are here; tests 1, 2, 3 and 9 concern writing and move to Plan 2.

**Two gaps closed by writing this down:** `CREDENTIAL_PATH` (§9) has no task here, because nothing in Plan 1 resolves a path to write — it belongs with `ApplyConfig` in Plan 2, and Plan 2 must not forget it. `awaiting-restart` is in the contract (Task 1) and in `compare`'s state union but is unreachable in Plan 1, since only a write can produce it; that is correct rather than dead, and Plan 2 reaches it.

**Placeholder scan.** No TBDs. Every code step carries the code. Two steps say "follow the shape of `<named existing file>`" — Task 7's Hono router and its test fixtures — which is a pointer to a real file in this repo rather than a placeholder, and is there deliberately: inventing a second route-test harness is worse than reusing the one that exists.

**Type consistency.** `ConfigValue` has `readable`/`observed`/`reason` in the contract (Task 1), the Go struct (Task 3) and `compare` (Task 6). `ConfigSetting` carries `id`/`harness`/`scope`/`policy`/`restartToTakeEffect` in all three. `resolveFor(stationId, nodeId, tenantId)` is called with three arguments in Task 7 and defined with three in Task 5 — and Task 5's note tells the implementer to fix the *test*, not the signature. The node returns `ConfigValue` and never `ConfigObservation`, in the interface comment, the struct and the global constraints.
