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

// A key that IS in the document but holds a list is neither absent nor drifted.
//
// `hermes.approvals.command_allowlist` is the setting the originating incident is
// about, and it is the one registered setting whose value is a list. Reporting it
// as `absent` ("declared, and the key is not in the document") would be a false
// sentence about a document that plainly contains the key, and reporting the raw
// text of an inline list as a scalar would compare as `drifted` forever. Both
// shapes must come back readable=false with a reason that says why — the same
// invariant an unreadable document holds: an unreadable or unreadable-shaped
// value must never collapse into "key absent".
func TestHermesObserveConfigPresentNonScalarIsUnreadableNotAbsent(t *testing.T) {
	cases := []struct{ name, body string }{
		{"a block list", "approvals:\n  mode: ask\n  command_allowlist:\n    - ls\n    - cat\n"},
		{"an inline list", "approvals:\n  mode: ask\n  command_allowlist: [ls, cat]\n"},
		{"a nested map", "approvals:\n  command_allowlist:\n    allow: ls\n"},
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
			if vals[0].Readable {
				t.Fatalf("a present non-scalar must report readable=false, got %+v", vals[0])
			}
			if vals[0].Observed != nil {
				t.Fatalf("a present non-scalar must carry no observed value, got %v", vals[0].Observed)
			}
			if !strings.Contains(vals[0].Reason, "scalar") {
				t.Fatalf("the reason must name why it could not be read, got %q", vals[0].Reason)
			}
		})
	}
}

// The limitation is honest, not invisible: the setting stays registered, because a
// later plan needs it, and the registry is the wire contract either way.
func TestHermesConfigRegistryStillCarriesTheListSetting(t *testing.T) {
	h, _ := hermesWithProfile(t, "approvals:\n  command_allowlist:\n    - ls\n")
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.command_allowlist" {
			return
		}
	}
	t.Fatal("command_allowlist must stay registered even while its value cannot be read as a scalar")
}
