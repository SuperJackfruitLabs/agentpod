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
			h, key := hermesWithProfile(t, c.body)
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

func TestHermesObserveConfigPresentNestedMapIsUnreadableNotAbsent(t *testing.T) {
	h, key := hermesWithProfile(t, "approvals:\n  command_allowlist:\n    allow: ls\n")
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
	h, _ := hermesWithProfile(t, "approvals:\n  command_allowlist:\n    - ls\n")
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.command_allowlist" {
			return
		}
	}
	t.Fatal("command_allowlist must stay registered")
}
