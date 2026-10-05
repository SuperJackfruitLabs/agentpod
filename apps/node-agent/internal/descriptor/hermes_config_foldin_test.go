package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermesskills"
)

// D12's acceptance test, three times over: the registry path must produce
// BYTE-IDENTICAL output to the `apn` verb it folds in, on the same fixture.
// Not equivalent YAML — identical bytes. D5's whole claim is that an
// operator's formatting survives a write, so equivalence is not the bar.
//
// Each expected document below is an ORACLE: the bytes the shipped verb
// produces for that fixture, recorded independently of the registry path.
// For `hermes.skills.external_dirs` the oracle was recorded by plan Task 2,
// against the CLI exactly as shipped, before any of this work started, and
// is read from testdata rather than transcribed. For the two `plugins.*`
// settings the oracle is the literal below, and each test asserts the
// SHIPPED writer (hermeslive.PlanEnableConfig, which is what `apn
// hermes-live enable` itself calls) produces it, before it asserts the
// registry path produces it too — so the literal is checked against shipped
// code, never adjusted to whatever the new path happened to emit.

// hermesOracle reads a document recorded under
// apps/node-agent/testdata/hermes-skills-oracle — the SAME files
// cmd/agentpod-node's fixture test asserts the shipped verb against. Two
// copies of an oracle is two oracles, and the one that gets adjusted is
// whichever is nearer the code being changed.
func hermesOracle(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "hermes-skills-oracle", name))
	if err != nil {
		t.Fatalf("reading the recorded oracle %s: %v", name, err)
	}
	if len(data) == 0 {
		t.Fatalf("the recorded oracle %s is empty, so it cannot be an oracle", name)
	}
	return string(data)
}

// A profile that already has the stream flag the plugin needs, and one
// plugin of the operator's own in plugins.enabled. Enabling here adds
// exactly one line.
const foldInPluginsEnabledBefore = `# operator's own notes, which must survive
model: fixture-model
plugins:
  # why reasoning deltas are on
  stream_reasoning_deltas: true
  enabled:
    - operator-own-plugin
curator:
  enabled: true
`

const foldInPluginsEnabledAfter = `# operator's own notes, which must survive
model: fixture-model
plugins:
  # why reasoning deltas are on
  stream_reasoning_deltas: true
  enabled:
    - operator-own-plugin
    - agentpod-live
curator:
  enabled: true
`

// A profile where the plugin is already enabled and the operator had turned
// the stream flag off, with a trailing comment on that very line. Flipping
// it must keep the comment and the operator's spacing.
const foldInStreamBefore = `# operator's own notes, which must survive
model: fixture-model
plugins:
  enabled:
    - agentpod-live
  stream_reasoning_deltas: false   # the operator turned this off
curator:
  enabled: true
`

const foldInStreamAfter = `# operator's own notes, which must survive
model: fixture-model
plugins:
  enabled:
    - agentpod-live
  stream_reasoning_deltas: true   # the operator turned this off
curator:
  enabled: true
`

// foldInApply plans and applies `want` through the registry, the way any
// caller does, and returns the plan, the receipt and the document's bytes
// afterwards.
func foldInApply(t *testing.T, h *hermesDescriptor, key, cfg string, want []DeclaredSetting) (ConfigPlan, ConfigReceipt, string) {
	t.Helper()
	p, err := h.PlanConfig(context.Background(), key, "op_foldin", want)
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %s: %s", p.Refusal.Code, p.Refusal.Message)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_foldin", p.PlanDigest)
	if err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	body, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return p, r, string(body)
}

// requireTheShippedWriterProducesTheOracle checks the expected bytes against
// the writer the `apn` verb itself calls, BEFORE the registry path is
// compared to them. That ordering is the point: it is what makes the literal
// above an oracle rather than a transcription of whatever the new path
// emitted. If this assertion is the one that fails, the literal is wrong and
// fixing it is honest; if the next one fails, the delegation is wrong and
// D12 says it is abandoned, not reconciled.
func requireTheShippedWriterProducesTheOracle(t *testing.T, before, want string) {
	t.Helper()
	got, _, err := hermeslive.PlanEnableConfig([]byte(before))
	if err != nil {
		t.Fatalf("the shipped writer refused the fixture: %v", err)
	}
	if string(got) != want {
		t.Fatalf("the recorded oracle is not what the shipped writer produces — fix the oracle, not the delegation:\n--- want ---\n%s\n--- shipped writer ---\n%s", want, got)
	}
}

func requireIdenticalBytes(t *testing.T, what, want, got string) {
	t.Helper()
	if got == want {
		return
	}
	t.Fatalf("%s: the registry path did not produce the verb's bytes (D12: abandoned, not reconciled)\n--- want (%d bytes) ---\n%s\n--- got (%d bytes) ---\n%s",
		what, len(want), want, len(got), got)
}

// Setting 1 of 3: hermes.plugins.enabled, additive-only, delegating to the
// writer `apn hermes-live` calls.
func TestFoldInPluginsEnabledIsByteIdenticalToTheVerb(t *testing.T) {
	requireTheShippedWriterProducesTheOracle(t, foldInPluginsEnabledBefore, foldInPluginsEnabledAfter)
	h, key, cfg := hermesWithProfile(t, foldInPluginsEnabledBefore)
	_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
		{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}},
	})
	requireIdenticalBytes(t, "hermes.plugins.enabled", foldInPluginsEnabledAfter, got)
}

// Setting 2 of 3: hermes.plugins.stream_reasoning_deltas, reconcilable,
// delegating to the same writer — which is the only thing that sets it.
func TestFoldInStreamReasoningDeltasIsByteIdenticalToTheVerb(t *testing.T) {
	requireTheShippedWriterProducesTheOracle(t, foldInStreamBefore, foldInStreamAfter)
	h, key, cfg := hermesWithProfile(t, foldInStreamBefore)
	_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
		{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: true},
	})
	requireIdenticalBytes(t, "hermes.plugins.stream_reasoning_deltas", foldInStreamAfter, got)
}

// Setting 3 of 3: hermes.skills.external_dirs, additive-only, delegating to
// hermesskills — compared against the bytes plan Task 2 recorded from the
// shipped `apn hermes-skills` verb.
func TestFoldInSkillsExternalDirsIsByteIdenticalToTheVerb(t *testing.T) {
	before := hermesOracle(t, "before.yaml")
	want := hermesOracle(t, "after-register.yaml")
	// The same check the two plugin tests make, against the writer `apn
	// hermes-skills register` calls: the recorded oracle is what the shipped
	// verb produces, asserted before the registry path is compared to it.
	// cmd/agentpod-node's own fixture test asserts these same files against
	// the verb end to end, exit code and all.
	if edited, _, err := hermesskills.RegisterIn([]byte(before), "managed-skills"); err != nil {
		t.Fatalf("the shipped writer refused the fixture: %v", err)
	} else if string(edited) != want {
		t.Fatalf("the recorded oracle is not what the shipped writer produces — fix the oracle, not the delegation:\n--- want ---\n%s\n--- shipped writer ---\n%s", want, edited)
	}
	h, key, cfg := hermesWithProfile(t, before)
	_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
		{SettingID: "hermes.skills.external_dirs", Value: []string{"managed-skills"}},
	})
	requireIdenticalBytes(t, "hermes.skills.external_dirs", want, got)
}

// The two plugin settings are written by ONE indivisible writer, so
// declaring both together must run it once and produce the same document the
// verb writes into a profile that has no plugins section at all.
const foldInNoPluginsBefore = `model: fixture-model
curator:
  enabled: true
`

const foldInNoPluginsAfter = `model: fixture-model
curator:
  enabled: true
plugins:
  enabled:
    - agentpod-live
  stream_reasoning_deltas: true
`

func TestFoldInBothPluginSettingsTogetherAreByteIdenticalToTheVerb(t *testing.T) {
	requireTheShippedWriterProducesTheOracle(t, foldInNoPluginsBefore, foldInNoPluginsAfter)
	h, key, cfg := hermesWithProfile(t, foldInNoPluginsBefore)
	_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
		{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}},
		{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: true},
	})
	requireIdenticalBytes(t, "the plugin pair", foldInNoPluginsAfter, got)
}

// The three settings are registered, with the scopes and policies the plan's
// table names — a fold-in whose entry is not in the registry is refused by
// name (D1), so this is the precondition for every test above.
func TestFoldInSettingsAreRegisteredWithTheirPolicies(t *testing.T) {
	h, _, _ := hermesWithProfile(t, foldInPluginsEnabledBefore)
	byID := map[string]ConfigSetting{}
	for _, s := range h.ConfigSettings() {
		byID[s.ID] = s
	}
	for id, policy := range map[string]string{
		"hermes.plugins.enabled":                 "additive-only",
		"hermes.plugins.stream_reasoning_deltas": "reconcilable",
		"hermes.skills.external_dirs":            "additive-only",
	} {
		s, ok := byID[id]
		if !ok {
			t.Fatalf("registry is missing %s", id)
		}
		if s.Scope != "profile" {
			t.Errorf("%s: scope = %q, want profile", id, s.Scope)
		}
		if s.Policy != policy {
			t.Errorf("%s: policy = %q, want %s", id, s.Policy, policy)
		}
		if s.Harness != "hermes" {
			t.Errorf("%s: harness = %q, want hermes", id, s.Harness)
		}
	}
}

// ErrDisabledByOperator is the harness's OWN record that an operator turned
// the plugin off, and it must surface as an opt-out — not as a shape
// problem, and never as a write that overrides the operator.
func TestFoldInAHarnessOptOutRefusesAsOptedOut(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, "model: fixture\nplugins:\n  disabled:\n    - agentpod-live\n")
	before, _ := os.ReadFile(cfg)
	p, err := h.PlanConfig(context.Background(), key, "op_optout", []DeclaredSetting{
		{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}},
	})
	if err != nil {
		t.Fatalf("an opt-out is an answer, not an error: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "OPTED_OUT" {
		t.Fatalf("refusal = %+v, want OPTED_OUT", p.Refusal)
	}
	if !strings.Contains(p.Refusal.Message, "plugins.disabled") {
		t.Fatalf("the refusal must name the harness's own list as the source: %q", p.Refusal.Message)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a refused plan wrote to the document")
	}
}

// ErrConflict is a shape the reviewed writer will not edit. It must come back
// as a refused PLAN, with the writer's own sentence, rather than an error or
// a guess.
func TestFoldInAWriterConflictIsARefusedPlan(t *testing.T) {
	cases := map[string]struct {
		doc  string
		want []DeclaredSetting
	}{
		"plugins is a sequence, not a mapping": {
			"model: fixture\nplugins:\n  - one\n",
			[]DeclaredSetting{{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}}},
		},
		"stream_reasoning_deltas is not a boolean": {
			"model: fixture\nplugins:\n  enabled:\n    - agentpod-live\n  stream_reasoning_deltas: maybe\n",
			[]DeclaredSetting{{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: true}},
		},
		"skills is not a mapping": {
			"model: fixture\nskills: none\n",
			[]DeclaredSetting{{SettingID: "hermes.skills.external_dirs", Value: []string{"managed-skills"}}},
		},
		"external_dirs is not a sequence": {
			"model: fixture\nskills:\n  external_dirs: one\n",
			[]DeclaredSetting{{SettingID: "hermes.skills.external_dirs", Value: []string{"managed-skills"}}},
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h, key, cfg := hermesWithProfile(t, tc.doc)
			before, _ := os.ReadFile(cfg)
			p, err := h.PlanConfig(context.Background(), key, "op_conflict", tc.want)
			if err != nil {
				t.Fatalf("a conflict is a refused plan, not an error: %v", err)
			}
			if p.Refusal == nil || p.Refusal.Code != "SHAPE_UNEXPECTED" {
				t.Fatalf("refusal = %+v, want SHAPE_UNEXPECTED", p.Refusal)
			}
			after, _ := os.ReadFile(cfg)
			if string(before) != string(after) {
				t.Fatal("a refused plan wrote to the document")
			}
		})
	}
}

// The declared value has to be one the delegated writer can actually
// produce. The plugin writer only ever enables THIS plugin and only ever
// sets the stream flag to true; anything else is refused by name rather
// than half-written or reimplemented here (D12).
func TestFoldInRefusesADeclaredValueTheWriterCannotProduce(t *testing.T) {
	cases := map[string]struct {
		doc  string
		want []DeclaredSetting
		says string
	}{
		"another plugin declared for plugins.enabled": {
			foldInPluginsEnabledBefore,
			[]DeclaredSetting{{SettingID: "hermes.plugins.enabled", Value: []string{"some-other-plugin"}}},
			"some-other-plugin",
		},
		"the stream flag declared false": {
			foldInStreamBefore,
			[]DeclaredSetting{{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: false}},
			"hermes-live",
		},
		"the stream flag declared as a string": {
			foldInStreamBefore,
			[]DeclaredSetting{{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: "true"}},
			"true",
		},
		"external_dirs declared as a scalar": {
			"model: fixture\n",
			[]DeclaredSetting{{SettingID: "hermes.skills.external_dirs", Value: "managed-skills"}},
			"list of strings",
		},
		"an absolute path declared for external_dirs": {
			"model: fixture\n",
			[]DeclaredSetting{{SettingID: "hermes.skills.external_dirs", Value: []string{"/etc/skills"}}},
			"relative",
		},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			h, key, cfg := hermesWithProfile(t, tc.doc)
			before, _ := os.ReadFile(cfg)
			p, err := h.PlanConfig(context.Background(), key, "op_shape", tc.want)
			if err != nil {
				t.Fatalf("PlanConfig: %v", err)
			}
			if p.Refusal == nil || p.Refusal.Code != "SHAPE_UNEXPECTED" {
				t.Fatalf("refusal = %+v, want SHAPE_UNEXPECTED", p.Refusal)
			}
			if !strings.Contains(p.Refusal.Message, tc.says) {
				t.Fatalf("the refusal must say what it cannot do (%q): %q", tc.says, p.Refusal.Message)
			}
			after, _ := os.ReadFile(cfg)
			if string(before) != string(after) {
				t.Fatal("a refused plan wrote to the document")
			}
		})
	}
}

// F2, through the folded-in additive settings: a write must never remove an
// entry the operator already had. Both additive settings are checked, and
// the declared list deliberately does NOT name the operator's own entry.
func TestFoldInAdditiveWritesKeepEveryOperatorEntry(t *testing.T) {
	t.Run("plugins.enabled", func(t *testing.T) {
		h, key, cfg := hermesWithProfile(t, foldInPluginsEnabledBefore)
		_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
			{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}},
		})
		if !strings.Contains(got, "- operator-own-plugin") {
			t.Fatalf("an additive-only write removed an operator's entry — F2's worst outcome:\n%s", got)
		}
	})
	t.Run("skills.external_dirs", func(t *testing.T) {
		h, key, cfg := hermesWithProfile(t, hermesOracle(t, "before.yaml"))
		_, _, got := foldInApply(t, h, key, cfg, []DeclaredSetting{
			{SettingID: "hermes.skills.external_dirs", Value: []string{"managed-skills"}},
		})
		if !strings.Contains(got, "- operator-own-dir") {
			t.Fatalf("an additive-only write removed an operator's entry — F2's worst outcome:\n%s", got)
		}
	})
}

// Declaring a folded-in setting that is already satisfied is a no-op: the
// plan says so and the document is not rewritten.
func TestFoldInAnAlreadySatisfiedSettingIsANoOp(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, foldInPluginsEnabledAfter)
	before, _ := os.ReadFile(cfg)
	p, err := h.PlanConfig(context.Background(), key, "op_noop", []DeclaredSetting{
		{SettingID: "hermes.plugins.enabled", Value: []string{"agentpod-live"}},
		{SettingID: "hermes.plugins.stream_reasoning_deltas", Value: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %+v", p.Refusal)
	}
	if !p.NoOp {
		t.Fatalf("a document that already satisfies both settings must plan as a no-op: %#v", p.Entries)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("planning wrote to the document")
	}
}

// The folded-in settings are observable too — a setting that can be written
// but not read would report drift forever.
func TestFoldInSettingsAreObservable(t *testing.T) {
	h, key, _ := hermesWithProfile(t, foldInPluginsEnabledAfter)
	vals, err := h.ObserveConfig(context.Background(), key, []string{
		"hermes.plugins.enabled", "hermes.plugins.stream_reasoning_deltas",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 2 {
		t.Fatalf("got %d values, want 2", len(vals))
	}
	for _, v := range vals {
		if !v.Readable {
			t.Fatalf("%s is not readable: %s", v.SettingID, v.Reason)
		}
	}
}
