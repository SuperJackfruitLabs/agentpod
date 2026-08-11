package posture

import (
	"os"
	"path/filepath"
	"testing"
)

// hermesProfile builds ~/.hermes/profiles/<name>/ with the files molt-bot has.
func hermesProfile(t *testing.T, home, name string, mode os.FileMode) {
	t.Helper()
	dir := filepath.Join(home, ".hermes", "profiles", name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"auth.json", ".env"} {
		p := filepath.Join(dir, f)
		if err := os.WriteFile(p, []byte("{}"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
	}
}

// openclawAgent builds ~/.openclaw/agents/<name>/agent/ as on superchotu.
func openclawAgent(t *testing.T, home, name string, mode os.FileMode) {
	t.Helper()
	dir := filepath.Join(home, ".openclaw", "agents", name, "agent")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"auth.json", "auth-profiles.json", "auth-state.json"} {
		p := filepath.Join(dir, f)
		if err := os.WriteFile(p, []byte("{}"), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPerProfileHermesCredentialsAreChecked(t *testing.T) {
	// Confirmed on molt-bot: every profile has its own auth.json holding an
	// access token. The shipped scan never looked below ~/.hermes.
	defer forceExposure(t, Exposure{World: true})()

	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o644)

	var fails int
	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			fails++
		}
	}
	if fails == 0 {
		t.Fatal("a world-readable per-profile credential file must be reported")
	}
}

func TestPerAgentOpenclawCredentialsAreChecked(t *testing.T) {
	defer forceExposure(t, Exposure{World: true})()

	home := t.TempDir()
	openclawAgent(t, home, "hanuman", 0o644)

	var fails int
	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			fails++
		}
	}
	if fails == 0 {
		t.Fatal("a world-readable per-agent credential file must be reported")
	}
}

func TestPerProfileFindingsCarryTheStationKey(t *testing.T) {
	// The console joins a finding to a station by equality on this key, so the
	// format must match what hermes.go/openclaw.go produce.
	//
	// Hardcoded rather than imported from descriptor on purpose: this package's
	// doc comment keeps it free of the descriptor layer so the checks stay unit
	// testable. The cost is that the two can drift, which is why the expected
	// strings are spelled out here where a reader will see them.
	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o600)
	openclawAgent(t, home, "hanuman", 0o600)

	want := map[string]bool{"hermes:analyst-echo": false, "openclaw:hanuman": false}
	for _, f := range CheckStationCredentials(home) {
		if _, ok := want[f.Station]; ok {
			want[f.Station] = true
		}
	}
	for k, seen := range want {
		if !seen {
			t.Errorf("no finding carried station key %q", k)
		}
	}
}

func TestSecuredProfilesProduceNoFailures(t *testing.T) {
	home := t.TempDir()
	hermesProfile(t, home, "analyst-echo", 0o600)
	openclawAgent(t, home, "hanuman", 0o600)

	for _, f := range CheckStationCredentials(home) {
		if f.Status == StatusFail {
			t.Errorf("a 600 file must not be a failure: %+v", f)
		}
	}
}

func TestProfilesAreDiscoveredNotHardcoded(t *testing.T) {
	// molt-bot has 15 profiles with arbitrary names; superchotu has 12 agents.
	home := t.TempDir()
	for _, n := range []string{"analyst-echo", "coder-kai", "threat-hunter-theo"} {
		hermesProfile(t, home, n, 0o600)
	}
	seen := map[string]bool{}
	for _, f := range CheckStationCredentials(home) {
		if f.Station != "" {
			seen[f.Station] = true
		}
	}
	if len(seen) != 3 {
		t.Errorf("discovered %d profiles, want 3: %v", len(seen), seen)
	}
}

func TestNoProfilesIsSilent(t *testing.T) {
	if got := CheckStationCredentials(t.TempDir()); len(got) != 0 {
		t.Errorf("a home with no composite harnesses should produce nothing, got %+v", got)
	}
}
