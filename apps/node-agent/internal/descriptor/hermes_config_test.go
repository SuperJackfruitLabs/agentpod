package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// hermesWithProfile writes a Hermes home with one profile whose config.yaml is
// `body`, and returns the descriptor, the station key for that profile, and
// the profile's config.yaml path (plan tests read the file back to prove
// PlanConfig wrote nothing).
func hermesWithProfile(t *testing.T, body string) (*hermesDescriptor, string, string) {
	t.Helper()
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(profile, "config.yaml")
	if err := os.WriteFile(cfg, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return NewHermes(home).(*hermesDescriptor), "hermes:one", cfg
}

func TestHermesConfigSettingsRegistry(t *testing.T) {
	h, _, _ := hermesWithProfile(t, "approvals:\n  timeout: 300\n")
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
	h, key, _ := hermesWithProfile(t, "approvals:\n  mode: ask\n  timeout: 900\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 || !vals[0].Readable || vals[0].Observed != "900" {
		t.Fatalf("got %+v; want one readable 900", vals)
	}
}

func TestHermesObserveConfigAbsentKeyIsReadableWithNoValue(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  mode: ask\n")
	vals, _ := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if !vals[0].Readable {
		t.Fatal("a readable document with the key absent is readable")
	}
	if vals[0].Observed != nil {
		t.Fatalf("absent key must carry no value, got %v", vals[0].Observed)
	}
}

func TestHermesObserveConfigUnreadableDocumentIsNotAbsent(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
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
	h, _, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	_, err := h.ObserveConfig(context.Background(), "hermes", []string{"hermes.approvals.timeout"})
	if err == nil || !strings.Contains(err.Error(), "composite root") {
		t.Fatalf("the composite root must be refused, got %v", err)
	}
}

func TestHermesObserveConfigRefusesAnUnregisteredSetting(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	_, err := h.ObserveConfig(context.Background(), key, []string{"hermes.model.api_key"})
	if err == nil || !strings.Contains(err.Error(), "hermes.model.api_key") {
		t.Fatalf("an unregistered setting must be refused by name, got %v", err)
	}
}

// A key that IS in the document but holds a list is neither absent nor
// unreadable — it is readable, with the list as its observed value.
//
// `hermes.approvals.command_allowlist` is the setting the originating incident
// is about, and it is the one registered setting whose value is a list in
// every real document. Reporting it as `absent` ("declared, and the key is
// not in the document") would be a false sentence about a document that
// plainly contains the key, and treating an inline list's raw text as a
// scalar would compare as `drifted` forever — which is why both block and
// inline lists are read structurally (via configedit) rather than as text.
//
// This used to report readable=false for every non-scalar shape, lists
// included — a false negative on the one setting this whole design exists
// for. That changed here; a nested map (not a shape any registered setting
// has today) still reports unreadable, for the same reason an unreadable
// document does: a shape this reader cannot speak for must never collapse
// into "key absent" or be guessed at as a scalar.
func TestHermesObserveConfigPresentListIsReadableWithTheListObserved(t *testing.T) {
	cases := []struct{ name, body string }{
		{"a block list", "approvals:\n  mode: ask\n  command_allowlist:\n    - ls\n    - cat\n"},
		{"an inline list", "approvals:\n  mode: ask\n  command_allowlist: [ls, cat]\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, key, _ := hermesWithProfile(t, c.body)
			vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.command_allowlist"})
			if err != nil {
				t.Fatal(err)
			}
			if len(vals) != 1 {
				t.Fatalf("got %d values, want 1", len(vals))
			}
			if !vals[0].Readable {
				t.Fatalf("a present list must report readable=true, got %+v", vals[0])
			}
			items, ok := vals[0].Observed.([]any)
			if !ok || len(items) != 2 {
				t.Fatalf("want a 2-item observed list, got %#v", vals[0].Observed)
			}
			if items[0] != "ls" || items[1] != "cat" {
				t.Fatalf("observed list = %#v, want [ls cat]", items)
			}
		})
	}
}

// An EMPTY block list — `command_allowlist:` with no items under it — is the
// third list shape, and the one a document carries after an operator deletes
// the last entry. It holds nothing, which is not the same thing as holding a
// nested map: calling it unreadable was a false sentence about the document,
// and `compare()` turns `unreadable` into a recorded failure at adopt time
// and never plans the write at all.
//
// The published page (docs-site/.../use/config.md) already says "a block
// list, an inline list, and an empty list all come back readable, with the
// list itself as the observed value". This is that sentence, as a test.
func TestHermesObserveConfigEmptyListIsReadableAsAnEmptyList(t *testing.T) {
	for _, c := range []struct{ name, body string }{
		{"an empty block list", "approvals:\n  mode: ask\n  command_allowlist:\n"},
		{"an empty inline list", "approvals:\n  mode: ask\n  command_allowlist: []\n"},
	} {
		t.Run(c.name, func(t *testing.T) {
			h, key, _ := hermesWithProfile(t, c.body)
			vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.command_allowlist"})
			if err != nil {
				t.Fatal(err)
			}
			if !vals[0].Readable {
				t.Fatalf("an empty list must report readable=true, got %+v", vals[0])
			}
			items, ok := vals[0].Observed.([]any)
			if !ok {
				t.Fatalf("observed = %#v, want an (empty) list", vals[0].Observed)
			}
			if len(items) != 0 {
				t.Fatalf("observed = %#v, want no entries", items)
			}
		})
	}
}

func TestHermesObserveConfigPresentNestedMapIsUnreadableNotAbsent(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  command_allowlist:\n    allow: ls\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.command_allowlist"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 {
		t.Fatalf("got %d values, want 1", len(vals))
	}
	if vals[0].Readable {
		t.Fatalf("a present nested map must report readable=false, got %+v", vals[0])
	}
	if vals[0].Observed != nil {
		t.Fatalf("a present nested map must carry no observed value, got %v", vals[0].Observed)
	}
	if !strings.Contains(vals[0].Reason, "map") {
		t.Fatalf("the reason must name why it could not be read, got %q", vals[0].Reason)
	}
}

// The registry carries this setting regardless of what shape its value turns
// out to be — the registry is the wire contract either way, and a later plan
// needs the setting to stay declarable even on a shape this reader cannot
// speak for.
func TestHermesConfigRegistryStillCarriesTheListSetting(t *testing.T) {
	h, _, _ := hermesWithProfile(t, "approvals:\n  command_allowlist:\n    - ls\n")
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.command_allowlist" {
			return
		}
	}
	t.Fatal("command_allowlist must stay registered")
}

// D11: the harness's OWN opt-out — `plugins.disabled` naming the agentpod-live
// plugin — must reach the hub as `ConfigValue.optedOutByHarness`. This is a
// document-level fact (every setting this registry manages today lives in
// the same profile document the plugin's own enablement lives in), computed
// once per ObserveConfig call, not re-derived per setting id.
func TestHermesObserveConfigReportsTheHarnesssOwnOptOut(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\nplugins:\n  disabled:\n    - agentpod-live\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if err != nil {
		t.Fatal(err)
	}
	if len(vals) != 1 {
		t.Fatalf("got %d values, want 1", len(vals))
	}
	if !vals[0].OptedOutByHarness {
		t.Fatalf("plugins.disabled naming agentpod-live must set OptedOutByHarness, got %+v", vals[0])
	}
	// The ordinary observed value is still reported — the harness's opt-out
	// does not make the document unreadable or the value absent.
	if vals[0].Observed != "900" {
		t.Fatalf("observed = %v, want 900", vals[0].Observed)
	}
}

// The absence case, proven alongside the presence case so a test that cannot
// distinguish "false" from "field never set" is not mistaken for coverage.
func TestHermesObserveConfigWithNoHarnessOptOutReportsFalse(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if err != nil {
		t.Fatal(err)
	}
	if vals[0].OptedOutByHarness {
		t.Fatalf("no plugins.disabled entry at all must report OptedOutByHarness=false, got %+v", vals[0])
	}
}

// A document whose plugins.disabled list names some OTHER plugin must not be
// mistaken for naming agentpod-live — this is a membership test, not "the key
// is present".
func TestHermesObserveConfigOtherPluginDisabledDoesNotOptOut(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 900\nplugins:\n  disabled:\n    - some-other-plugin\n")
	vals, err := h.ObserveConfig(context.Background(), key, []string{"hermes.approvals.timeout"})
	if err != nil {
		t.Fatal(err)
	}
	if vals[0].OptedOutByHarness {
		t.Fatalf("a different plugin in plugins.disabled must not opt this out, got %+v", vals[0])
	}
}
