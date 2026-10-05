package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/openclawerrors"
)

// D12's acceptance test for OpenClaw, mirroring
// hermes_config_foldin_test.go's pattern: the registry path must produce
// BYTE-IDENTICAL output to `apn openclaw-errors` on the same fixture — not
// equivalent JSON, identical bytes. Each test asserts the SHIPPED writer
// (openclawerrors.EnableConfig/DisableConfig, which is what
// `apn openclaw-errors enable`/`disable` themselves call) produces the
// literal below BEFORE asserting the registry path produces it too, so the
// literal is an oracle rather than a transcription of whatever the new path
// happened to emit. If the first assertion fails, the literal is wrong and
// fixing it is honest; if the second fails, the delegation is wrong and D12
// says it is abandoned, not reconciled.

// openclawWithHome writes a fake "<userHome>/.openclaw/openclaw.json" holding
// body, and returns the descriptor, the root station key, the config path,
// and the user home directory a test needs to compute the SAME plugin
// directory string the registry derives internally
// (openclawErrorsPluginDir), so an oracle call and the registry path agree
// on what gets embedded in plugins.load.paths.
func openclawWithHome(t *testing.T, body string) (*openclawDescriptor, string, string, string) {
	t.Helper()
	userHome := t.TempDir()
	home := filepath.Join(userHome, ".openclaw")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(home, "openclaw.json")
	if err := os.WriteFile(cfg, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewOpenClaw(home).(*openclawDescriptor), "openclaw", cfg, userHome
}

// foldInOpenClawApply plans and applies `want` through the registry, the way
// any caller does, and returns the plan, the receipt, and the document's
// bytes afterwards.
func foldInOpenClawApply(t *testing.T, o *openclawDescriptor, key, cfg string, want []DeclaredSetting) (ConfigPlan, ConfigReceipt, string) {
	t.Helper()
	p, err := o.PlanConfig(context.Background(), key, "op_foldin", want)
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %s: %s", p.Refusal.Code, p.Refusal.Message)
	}
	r, err := o.ApplyConfig(context.Background(), key, "op_foldin", p.PlanDigest)
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

// A document with a sibling plugin already configured, and nothing of ours
// yet — exactly the shape openclawerrors' own TestEnableAddsOnlyWhatItOwns
// exercises, so a sibling entry surviving is checked here too.
const foldInOpenClawBefore = `{
  "meta": { "lastTouchedVersion": "2026.7.1-2" },
  "plugins": {
    "entries": { "telegram": { "enabled": true } }
  },
  "env": { "A": "1" }
}
`

func TestFoldInOpenClawEnableIsByteIdenticalToTheVerb(t *testing.T) {
	o, key, cfg, userHome := openclawWithHome(t, foldInOpenClawBefore)
	pluginDir := openclawerrors.PluginDir(userHome)

	want, err := openclawerrors.EnableConfig([]byte(foldInOpenClawBefore), pluginDir)
	if err != nil {
		t.Fatalf("the shipped writer refused the fixture: %v", err)
	}

	_, _, got := foldInOpenClawApply(t, o, key, cfg, []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})
	if got != string(want) {
		t.Fatalf("the registry path did not produce the verb's bytes (D12: abandoned, not reconciled)\n--- want (%d bytes) ---\n%s\n--- got (%d bytes) ---\n%s",
			len(want), want, len(got), got)
	}
	if !strings.Contains(string(got), `"telegram"`) {
		t.Fatalf("a sibling plugin entry was lost:\n%s", got)
	}
}

func TestFoldInOpenClawDisableIsByteIdenticalToTheVerb(t *testing.T) {
	o, key, cfg, userHome := openclawWithHome(t, foldInOpenClawBefore)
	pluginDir := openclawerrors.PluginDir(userHome)

	// Enable it first (through the registry, already proven byte-identical
	// above), then declare it off — disableConfig only needs the CURRENT
	// document, unlike hermeslive's reversal, so this needs no recorded
	// ConfigChange.
	_, _, enabled := foldInOpenClawApply(t, o, key, cfg, []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})

	want, err := openclawerrors.DisableConfig([]byte(enabled), pluginDir)
	if err != nil {
		t.Fatalf("the shipped writer refused the fixture: %v", err)
	}

	p, err := o.PlanConfig(context.Background(), key, "op_disable", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: false},
	})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %s: %s", p.Refusal.Code, p.Refusal.Message)
	}
	r, err := o.ApplyConfig(context.Background(), key, "op_disable", p.PlanDigest)
	if err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	got, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("the registry path did not produce the verb's bytes (D12: abandoned, not reconciled)\n--- want (%d bytes) ---\n%s\n--- got (%d bytes) ---\n%s",
			len(want), want, len(got), got)
	}
	// NOT asserted: byte-identity with foldInOpenClawBefore. splicePlugins
	// re-indents the WHOLE "plugins" value on every write (openclawerrors'
	// own TestDisableRemovesOnlyWhatItAdded compares semantically for
	// exactly this reason), so the surviving "telegram" entry's formatting
	// is not restored to its pre-enable compact style — a pre-existing
	// property of the shipped writer, not something this delegation adds.
	if !strings.Contains(string(got), `"telegram"`) {
		t.Fatalf("a sibling plugin entry was lost:\n%s", got)
	}
}

func TestOpenClawConfigSettingsRegistry(t *testing.T) {
	o, _, _, _ := openclawWithHome(t, foldInOpenClawBefore)
	byID := map[string]ConfigSetting{}
	for _, s := range o.ConfigSettings() {
		byID[s.ID] = s
	}
	s, ok := byID[openclawAllowConversationAccessID]
	if !ok {
		t.Fatalf("registry is missing %s", openclawAllowConversationAccessID)
	}
	if s.Harness != "openclaw" {
		t.Errorf("harness = %q, want openclaw", s.Harness)
	}
	// spec F6/D7: OpenClaw keeps one configuration file per host, so this
	// setting is user-scoped, not profile-scoped — a station-scoped
	// declaration of it is refused `out-of-scope` by the hub's existing,
	// harness-agnostic scope rule because the hub's `compare()` fires that
	// refusal for ANY setting whose scope != "profile" declared at station
	// level (apps/hub/src/services/harness-config.ts). That rule is already
	// exercised against this EXACT setting id in
	// apps/hub/tests/unit/harness-config-compare.test.ts
	// ("a station-scoped declaration for a user-scoped setting is
	// out-of-scope"), so no node-side refusal is added here.
	if s.Scope != "user" {
		t.Errorf("scope = %q, want user", s.Scope)
	}
	if s.Policy != "reconcilable" {
		t.Errorf("policy = %q, want reconcilable", s.Policy)
	}
	if !s.RestartToTakeEffect {
		t.Error("restartToTakeEffect must be true: the gateway reads plugins at start")
	}
}

func TestOpenClawConfigSettingsAreObservable(t *testing.T) {
	o, key, cfg, userHome := openclawWithHome(t, foldInOpenClawBefore)
	pluginDir := openclawerrors.PluginDir(userHome)

	// Absent before anything is written.
	vals, err := o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || !vals[0].Readable || vals[0].Observed != nil {
		t.Fatalf("fresh fixture: got %+v, want readable with no observed value", vals)
	}

	after, err := openclawerrors.EnableConfig([]byte(foldInOpenClawBefore), pluginDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, after, 0o644); err != nil {
		t.Fatal(err)
	}

	vals, err = o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || !vals[0].Readable {
		t.Fatalf("got %+v, want readable", vals)
	}
	if v, ok := vals[0].Observed.(bool); !ok || !v {
		t.Fatalf("Observed = %#v, want true", vals[0].Observed)
	}
}

func TestOpenClawObserveConfigRefusesAnUnregisteredID(t *testing.T) {
	o, key, _, _ := openclawWithHome(t, foldInOpenClawBefore)
	if _, err := o.ObserveConfig(context.Background(), key, []string{"openclaw.not.a.real.setting"}); err == nil {
		t.Fatal("an unregistered setting id was not refused by name")
	}
}

func TestOpenClawPlanRefusesAnUnregisteredID(t *testing.T) {
	o, key, cfg, _ := openclawWithHome(t, foldInOpenClawBefore)
	before, _ := os.ReadFile(cfg)
	p, err := o.PlanConfig(context.Background(), key, "op_unknown", []DeclaredSetting{
		{SettingID: "openclaw.not.a.real.setting", Value: true},
	})
	if err != nil {
		t.Fatalf("an unregistered setting is a refused plan, not an error: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "UNKNOWN_SETTING" {
		t.Fatalf("refusal = %+v, want UNKNOWN_SETTING", p.Refusal)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a refused plan wrote to the document")
	}
}

func TestOpenClawPlanRefusesANonBooleanValue(t *testing.T) {
	o, key, cfg, _ := openclawWithHome(t, foldInOpenClawBefore)
	before, _ := os.ReadFile(cfg)
	p, err := o.PlanConfig(context.Background(), key, "op_shape", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: "true"},
	})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "SHAPE_UNEXPECTED" {
		t.Fatalf("refusal = %+v, want SHAPE_UNEXPECTED", p.Refusal)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a refused plan wrote to the document")
	}
}

// ErrConflict's JSON-side equivalent: a document shape the delegated writer
// will not edit comes back as a refused PLAN, with the writer's own
// sentence, never as an error or a guess.
func TestOpenClawPlanRefusesAWriterConflict(t *testing.T) {
	const badShape = `{"plugins": ["not", "an", "object"]}`
	o, key, cfg, _ := openclawWithHome(t, badShape)
	before, _ := os.ReadFile(cfg)
	p, err := o.PlanConfig(context.Background(), key, "op_conflict", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})
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
}

func TestOpenClawPlanRefusesUnparseableJSON(t *testing.T) {
	o, key, cfg, _ := openclawWithHome(t, "{ // hand edited\n \"gateway\": {} }\n")
	before, _ := os.ReadFile(cfg)
	p, err := o.PlanConfig(context.Background(), key, "op_unreadable", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "UNREADABLE" {
		t.Fatalf("refusal = %+v, want UNREADABLE", p.Refusal)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a refused plan wrote to the document")
	}
}

// Declaring a folded-in setting that is already satisfied is a no-op: the
// plan says so and the document is not rewritten.
func TestOpenClawAnAlreadySatisfiedSettingIsANoOp(t *testing.T) {
	o, key, cfg, _ := openclawWithHome(t, foldInOpenClawBefore)
	foldInOpenClawApply(t, o, key, cfg, []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})

	before, _ := os.ReadFile(cfg)
	p, err := o.PlanConfig(context.Background(), key, "op_noop", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %+v", p.Refusal)
	}
	if !p.NoOp {
		t.Fatalf("a document that already satisfies the setting must plan as a no-op: %#v", p.Entries)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("planning wrote to the document")
	}
}

// ─── D6: the harness's own opt-out wins (Task 5b) ───────────────────────────
//
// OpenClaw's own mechanism for an operator to turn the agentpod-errors
// plugin off, through OpenClaw's own UI, is
// plugins.entries.agentpod-errors.enabled: false (install.go's package
// comment documents this key; install.go:317's Observe reads it as the
// plugin's Enabled status). The delegated writer (openclawerrors.EnableConfig)
// is indivisible — enabling hooks.allowConversationAccess ALSO sets that key
// to true — so declaring this setting while an operator has explicitly
// turned the plugin off must not silently reverse that choice (D6).
//
// Three states, each its own test, mirroring
// TestHermesObserveConfigReportsTheHarnesssOwnOptOut /
// TestHermesObserveConfigWithNoHarnessOptOutReportsFalse: explicitly false
// opts out; ABSENT does not (a fresh install has no entry at all — see
// foldInOpenClawBefore, which has a sibling "telegram" entry but none of
// ours); explicitly true does not either.

const foldInOpenClawDisabledByOperator = `{
  "plugins": {
    "entries": {
      "telegram": { "enabled": true },
      "agentpod-errors": { "enabled": false }
    }
  }
}
`

const foldInOpenClawEnabledByOperator = `{
  "plugins": {
    "entries": {
      "agentpod-errors": { "enabled": true }
    }
  }
}
`

func TestOpenClawObserveConfigReportsTheHarnesssOwnOptOut(t *testing.T) {
	o, key, _, _ := openclawWithHome(t, foldInOpenClawDisabledByOperator)
	vals, err := o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || !vals[0].Readable {
		t.Fatalf("got %+v, want 1 readable value", vals)
	}
	if !vals[0].OptedOutByHarness {
		t.Fatalf("plugins.entries.agentpod-errors.enabled: false must set OptedOutByHarness, got %+v", vals[0])
	}
}

// The absence case, proven alongside the presence case so a test that cannot
// distinguish "false" from "field never set" is not mistaken for coverage —
// a fresh OpenClaw station (foldInOpenClawBefore has no agentpod-errors
// entry at all) must NOT read as opted-out, or every fresh station would
// block the fold-in entirely.
func TestOpenClawObserveConfigWithNoHarnessOptOutReportsFalse(t *testing.T) {
	o, key, _, _ := openclawWithHome(t, foldInOpenClawBefore)
	vals, err := o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if vals[0].OptedOutByHarness {
		t.Fatalf("no agentpod-errors entry at all must report OptedOutByHarness=false, got %+v", vals[0])
	}
}

// The third state: enabled explicitly TRUE is not opted-out either —
// conflating "present" with "disabled" would be a different bug than
// conflating "absent" with "disabled", and both are worth their own guard.
func TestOpenClawObserveConfigEnabledTrueReportsFalse(t *testing.T) {
	o, key, _, _ := openclawWithHome(t, foldInOpenClawEnabledByOperator)
	vals, err := o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if vals[0].OptedOutByHarness {
		t.Fatalf("enabled: true must report OptedOutByHarness=false, got %+v", vals[0])
	}
}

// A sibling plugin disabled must not be mistaken for agentpod-errors being
// disabled — this is a keyed lookup, not "something in entries is false".
func TestOpenClawObserveConfigOtherPluginDisabledDoesNotOptOut(t *testing.T) {
	const body = `{"plugins": {"entries": {"telegram": {"enabled": false}}}}`
	o, key, _, _ := openclawWithHome(t, body)
	vals, err := o.ObserveConfig(context.Background(), key, []string{openclawAllowConversationAccessID})
	if err != nil {
		t.Fatal(err)
	}
	if vals[0].OptedOutByHarness {
		t.Fatalf("a different plugin disabled must not opt agentpod-errors out, got %+v", vals[0])
	}
}

// The consequence: PlanConfig must REFUSE rather than silently produce an
// edit that re-enables the plugin — this is the actual D6 violation Task 5
// left open, not just an observability gap. OPTED_OUT, mirroring the code
// hermes_config_foldin.go's delegatePlugins uses for the analogous Hermes
// case (hermeslive.ErrDisabledByOperator).
func TestOpenClawPlanRefusesToReEnableWhenOperatorDisabledThePlugin(t *testing.T) {
	o, key, cfg, _ := openclawWithHome(t, foldInOpenClawDisabledByOperator)
	before, _ := os.ReadFile(cfg)

	p, err := o.PlanConfig(context.Background(), key, "op_optedout", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: true},
	})
	if err != nil {
		t.Fatalf("an opt-out is a refused plan, not an error: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "OPTED_OUT" {
		t.Fatalf("refusal = %+v, want OPTED_OUT", p.Refusal)
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a refused plan wrote to the document")
	}
}

// Declaring the setting OFF while the plugin is already disabled is
// consistent with the opt-out, not a reversal of it, and must not be
// refused: only the direction that would re-enable the plugin is guarded.
func TestOpenClawPlanAllowsDisablingWhenAlreadyOptedOut(t *testing.T) {
	o, key, _, _ := openclawWithHome(t, foldInOpenClawDisabledByOperator)
	p, err := o.PlanConfig(context.Background(), key, "op_optedout_off", []DeclaredSetting{
		{SettingID: openclawAllowConversationAccessID, Value: false},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Refusal != nil {
		t.Fatalf("declaring the setting off must not be refused as opted-out: %+v", p.Refusal)
	}
}

// ─── The interface-satisfaction trap ────────────────────────────────────────
//
// `config.manage` is advertised behind `_, ok := d.(ConfigManager)`
// (registry.go), which compiles whether or not the concrete type conforms —
// a missing or mis-signed method makes the capability silently never appear,
// with no compile error anywhere, because nothing else in this codebase
// requires a Descriptor to also be a ConfigManager. These two tests are the
// guard: they hold a plain Descriptor (not a concrete *openclawDescriptor or
// *hermesDescriptor) and perform exactly the assertion registry.go performs.

func TestOpenClawDescriptorSatisfiesConfigManager(t *testing.T) {
	var d Descriptor = NewOpenClaw(t.TempDir())
	if _, ok := d.(ConfigManager); !ok {
		t.Fatal("the OpenClaw descriptor must implement ConfigManager, or config.manage silently never appears for any OpenClaw station")
	}
}

func TestHermesDescriptorStillSatisfiesConfigManager(t *testing.T) {
	var d Descriptor = NewHermes(t.TempDir())
	if _, ok := d.(ConfigManager); !ok {
		t.Fatal("the Hermes descriptor must implement ConfigManager, or config.manage silently never appears for any Hermes station")
	}
}
