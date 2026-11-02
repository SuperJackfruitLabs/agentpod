package hermes

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func TestDetectAllAdvertisesConfigManage(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
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

// The Hermes composite ROOT must NOT advertise config.manage.
//
// It carries an absolute WorkspacePath (the Hermes home) and its descriptor
// implements ConfigManager, so the capability gate used to admit it — while
// `ObserveConfig` refuses the root by name, because the home is not any
// profile's document. A station that advertises a capability its own node then
// refuses is worse than one that never advertised it: the hub reads the failed
// call as "this station could not be reached" and labels a perfectly readable
// document unreadable for every declared setting.
//
// The root is identified as a PARENTLESS composite, not by Kind alone: Hermes
// (and OpenClaw) give every profile station Kind "composite" too, so gating on
// the kind by itself would withdraw the capability from the profile stations
// that are the only place it can actually be used.
func TestDetectAllDoesNotAdvertiseConfigManageOnACompositeRoot(t *testing.T) {
	home := t.TempDir()
	profile := filepath.Join(home, "profiles", "one")
	if err := os.MkdirAll(profile, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(profile, "config.yaml"), []byte("approvals:\n  timeout: 300\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))
	reg.EnableConfigManagement()

	sawRoot, sawProfile := false, false
	for _, s := range reg.DetectAll() {
		has := slices.Contains(s.Capabilities, "config.manage")
		if s.Kind == "composite" && s.ParentKey == nil {
			sawRoot = true
			if has {
				t.Errorf("station %q is a composite root and must not advertise config.manage", s.Key)
			}
			continue
		}
		if has {
			sawProfile = true
		}
	}
	if !sawRoot {
		t.Fatal("this test needs a composite root station to be meaningful")
	}
	if !sawProfile {
		t.Fatal("a profile station must still advertise config.manage")
	}
}

func forgeCapStations(reg *descriptor.Registry) (with, total int) {
	for _, s := range reg.DetectAll() {
		total++
		for _, c := range s.Capabilities {
			if c == "forge.api" {
				with++
			}
		}
	}
	return
}

// The hub gates forge access on the STATION's capabilities (what detect reports), not on the
// node's hello, so the probe's answer must reach every station a detect lists.
func TestDetectAllAdvertisesForgeAPIOnlyWhileTheProbeSaysSo(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "profiles", "one"), 0o755); err != nil {
		t.Fatal(err)
	}
	reg := descriptor.NewRegistry()
	reg.Register(NewHermes(home, ""))

	if with, total := forgeCapStations(reg); total == 0 || with != 0 {
		t.Fatalf("with no probe configured forge.api must be absent, got %d/%d", with, total)
	}
	usable := false
	reg.SetForgeAPIProbe(func() bool { return usable })
	if with, _ := forgeCapStations(reg); with != 0 {
		t.Fatal("forge.api advertised while the probe says stk is unusable")
	}
	usable = true
	with, total := forgeCapStations(reg)
	if with != total || total == 0 {
		t.Fatalf("forge.api on %d of %d stations once the probe says yes", with, total)
	}
	usable = false
	if with, _ := forgeCapStations(reg); with != 0 {
		t.Fatal("forge.api must be withdrawn when the probe turns negative")
	}
}
