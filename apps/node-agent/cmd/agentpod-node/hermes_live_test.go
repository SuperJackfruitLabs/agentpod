package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
)

func fakeHermes(t *testing.T, probe descriptor.VersionProbe) {
	t.Helper()
	previous, previousNow := hermesLiveVersion, hermesLiveNow
	hermesLiveVersion = func(context.Context) descriptor.VersionProbe { return probe }
	hermesLiveNow = func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { hermesLiveVersion, hermesLiveNow = previous, previousNow })
}

func testedHermes() descriptor.VersionProbe {
	return descriptor.VersionProbe{Status: descriptor.VersionKnown, Version: hermeslive.TestedMax(), Reason: "fixture"}
}

func runHermesLive(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := hermesLiveCmd(args, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestHermesLiveReviewWritesNothing(t *testing.T) {
	fakeHermes(t, testedHermes())
	config := hermesProfileFixture(t, "model: fixture\n")
	code, out, errOut := runHermesLive(t, "enable", "--profile", "fixture")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	for _, want := range []string{"+ __init__.py", "+ plugin.yaml", "- agentpod-live", "stream_reasoning_deltas: true", "--apply"} {
		if !strings.Contains(out, want) {
			t.Errorf("review lacks %q:\n%s", want, out)
		}
	}
	if data, _ := os.ReadFile(config); string(data) != "model: fixture\n" {
		t.Fatalf("a review wrote the config:\n%s", data)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(config), "plugins")); !os.IsNotExist(err) {
		t.Fatal("a review wrote the plugin")
	}
}

func TestHermesLiveEnableStatusDisable(t *testing.T) {
	fakeHermes(t, testedHermes())
	config := hermesProfileFixture(t, "model: fixture\n")
	if code, _, errOut := runHermesLive(t, "enable", "--profile", "fixture", "--apply"); code != 0 {
		t.Fatalf("enable: %s", errOut)
	}
	code, out, _ := runHermesLive(t, "status", "--profile", "fixture")
	if code != 0 || !strings.Contains(out, "installed by apn") || !strings.Contains(out, "enabled:  yes") || !strings.Contains(out, "loaded:   unknown") {
		t.Fatalf("status:\n%s", out)
	}
	if code, out, errOut := runHermesLive(t, "enable", "--profile", "fixture", "--apply"); code != 0 || !strings.Contains(out, "nothing to do") {
		t.Fatalf("second enable: %d %s %s", code, out, errOut)
	}
	if code, _, errOut := runHermesLive(t, "disable", "--profile", "fixture", "--apply"); code != 0 {
		t.Fatalf("disable: %s", errOut)
	}
	if data, _ := os.ReadFile(config); string(data) != "model: fixture\n" {
		t.Fatalf("disable did not restore the config:\n%s", data)
	}
}

func TestHermesLiveRefusesAnUntestedHermesAndWritesNothing(t *testing.T) {
	fakeHermes(t, descriptor.VersionProbe{Status: descriptor.VersionKnown, Version: "99.0.0", Reason: "fixture"})
	config := hermesProfileFixture(t, "model: fixture\n")
	code, out, errOut := runHermesLive(t, "enable", "--profile", "fixture", "--apply")
	if code != 1 || !strings.Contains(errOut, "outside the range") || !strings.Contains(out, "untested here") {
		t.Fatalf("exit %d\nout: %s\nerr: %s", code, out, errOut)
	}
	if data, _ := os.ReadFile(config); string(data) != "model: fixture\n" {
		t.Fatal("a refused enable wrote the config")
	}
}

func TestHermesLiveHoldsWhenTheVersionIsUndetermined(t *testing.T) {
	fakeHermes(t, descriptor.VersionProbe{Status: descriptor.VersionUndetermined, TimedOut: true, Reason: "the version query timed out twice"})
	hermesProfileFixture(t, "model: fixture\n")
	code, out, errOut := runHermesLive(t, "enable", "--profile", "fixture", "--apply")
	if code != 1 || !strings.Contains(errOut, "could not be determined") || strings.Contains(errOut, "outside the range") {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "install held") || strings.Contains(out, "untested") {
		t.Fatalf("an undetermined version was worded as a verdict:\n%s", out)
	}
}

func TestHermesLiveRejectsAProfileThatIsNotOne(t *testing.T) {
	fakeHermes(t, testedHermes())
	hermesProfileFixture(t, "model: fixture\n")
	for _, profile := range []string{"../fixture", "..", "missing"} {
		if code, _, _ := runHermesLive(t, "status", "--profile", profile); code == 0 {
			t.Errorf("accepted --profile %q", profile)
		}
	}
}

// Hermes reserves "default" for its root profile, ~/.hermes, which is where a
// station on a host's own Hermes lives. It is never profiles/default.
func TestHermesLiveDefaultIsTheRootProfile(t *testing.T) {
	fakeHermes(t, testedHermes())
	home := t.TempDir()
	root := filepath.Join(home, ".hermes")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(config, []byte("model: fixture\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	code, out, errOut := runHermesLive(t, "enable", "--profile", "default", "--apply")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, "systemctl --user restart hermes-gateway.service") {
		t.Errorf("names the wrong gateway unit:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(root, "plugins", hermeslive.Name, "plugin.yaml")); err != nil {
		t.Fatalf("plugin not installed in the root profile: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "profiles")); !os.IsNotExist(err) {
		t.Fatal("wrote under profiles/")
	}
	if code, _, errOut := runHermesLive(t, "disable", "--profile", "default", "--apply"); code != 0 {
		t.Fatalf("disable: %s", errOut)
	}
	if data, _ := os.ReadFile(config); string(data) != "model: fixture\n" {
		t.Fatalf("disable did not restore the config:\n%s", data)
	}
}
