package service

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// What to tell an operator when the binary swapped and the restart did not.
//
// `apn update` on ashram printed "systemctl restart agentpod-node" at a host whose node runs as a
// USER unit under `openclaw`. That command fails there, so the advice sent the operator to a
// second dead end after the first one — and the scope was already known to this package, which
// probes `systemctl --user is-active` to decide how to restart in the first place.

func TestRestartHintNamesTheUserScopeWhenTheUnitIsAUserUnit(t *testing.T) {
	// The probe answering cleanly is what "there is a user unit here" means.
	run := func(name string, args ...string) (string, error) {
		if name == "systemctl" && len(args) > 0 && args[0] == "--user" {
			return "active", nil
		}
		return "", fmt.Errorf("unexpected: %s %v", name, args)
	}
	m, err := NewManagerForRestart("linux", run)
	if err != nil {
		t.Fatalf("NewManagerForRestart: %v", err)
	}
	got := m.RestartHint()
	if !strings.Contains(got, "--user") {
		t.Fatalf("hint does not name the user scope: %q", got)
	}
	if !strings.Contains(got, systemdUnitName) {
		t.Fatalf("hint does not name the unit: %q", got)
	}
}

func TestRestartHintNamesTheSystemScopeWhenThereIsNoUserUnit(t *testing.T) {
	run := func(string, ...string) (string, error) { return "", fmt.Errorf("inactive") }
	m, err := NewManagerForRestart("linux", run)
	if err != nil {
		t.Fatalf("NewManagerForRestart: %v", err)
	}
	got := m.RestartHint()
	if strings.Contains(got, "--user") {
		t.Fatalf("hint names the user scope on a system unit: %q", got)
	}
	if !strings.Contains(got, "systemctl restart "+systemdUnitName) {
		t.Fatalf("hint is not the system restart: %q", got)
	}
}

func TestRestartHintOnDarwinNamesLaunchctl(t *testing.T) {
	m, err := NewManagerForRestart("darwin", func(string, ...string) (string, error) { return "", nil })
	if err != nil {
		t.Fatalf("NewManagerForRestart: %v", err)
	}
	got := m.RestartHint()
	if !strings.Contains(got, "launchctl") {
		t.Fatalf("darwin hint does not name launchctl: %q", got)
	}
	// The uid is part of the launchd target; a hint without it is not runnable.
	if !strings.Contains(got, fmt.Sprintf("%d", os.Getuid())) {
		t.Fatalf("darwin hint omits the uid: %q", got)
	}
}
