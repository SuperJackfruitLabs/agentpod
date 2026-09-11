package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// build compiles apn once per test binary and returns its path.
func build(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "apn")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	if err != nil {
		t.Fatalf("build failed: %v\n%s", err, out)
	}
	return bin
}

// run executes apn with a clean, isolated environment.
func run(t *testing.T, bin string, env []string, args ...string) (string, int) {
	t.Helper()
	cmd := exec.Command(bin, args...)
	home := t.TempDir()
	cmd.Env = append([]string{
		"HOME=" + home,
		"XDG_CONFIG_HOME=" + home,
		"PATH=" + os.Getenv("PATH"),
	}, env...)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("running apn: %v", err)
	}
	return string(out), code
}

func TestFleetWithoutCredentialRefusesAndSaysHow(t *testing.T) {
	bin := build(t)
	out, code := run(t, bin, nil, "fleet", "whoami")

	if code == 0 {
		t.Fatal("a fleet command with no credential must not succeed")
	}
	// It has to name the fix, and distinguish itself from enrolment — the two are routinely
	// confused precisely because both are called "connecting to the hub".
	for _, want := range []string{"Not signed in", "apn fleet login", "AGENTPOD_TOKEN", "MACHINE"} {
		if !strings.Contains(out, want) {
			t.Errorf("refusal should mention %q, got:\n%s", want, out)
		}
	}
}

func TestFleetNeverUsesTheNodeCredential(t *testing.T) {
	bin := build(t)
	home := t.TempDir()

	// A fully enrolled machine, exactly as `apn enroll` leaves it.
	nodeDir := filepath.Join(home, "agentpod-node")
	if err := os.MkdirAll(nodeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := `{"hub":"https://hub.example","nodeId":"nod_x","nodeSecret":"s3cret-node"}`
	if err := os.WriteFile(filepath.Join(nodeDir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(bin, "fleet", "whoami")
	cmd.Env = []string{"HOME=" + home, "XDG_CONFIG_HOME=" + home, "PATH=" + os.Getenv("PATH")}
	out, _ := cmd.CombinedOutput()

	// This is the property that lets fleet verbs ship in the binary installed on every station.
	if !strings.Contains(string(out), "Not signed in") {
		t.Fatalf("an enrolled machine must still be 'not signed in' for fleet:\n%s", out)
	}
	if strings.Contains(string(out), "s3cret-node") {
		t.Fatal("the node secret leaked into a fleet command")
	}
}

func TestFleetWhoamiReadsTheTokenWithoutAHub(t *testing.T) {
	bin := build(t)
	// A well-formed JWT payload, signed with nonsense. `whoami` reports what you carry; it is
	// not an authorization decision, and it must not need the network to answer.
	tok := "aGRy.eyJzdWIiOiJwcm5fYWJjIiwicHJpbmNpcGFsS2luZCI6Imh1bWFuIn0.c2ln"
	out, code := run(t, bin, []string{"AGENTPOD_TOKEN=" + tok}, "fleet", "whoami")
	if code != 0 {
		t.Fatalf("whoami should succeed offline, got %d:\n%s", code, out)
	}
	if !strings.Contains(out, "prn_abc") || !strings.Contains(out, "human") {
		t.Fatalf("whoami should report the principal and kind:\n%s", out)
	}
}

func TestNodeIsAnAliasAndCannotDiverge(t *testing.T) {
	bin := build(t)
	// `apn version` and `apn node version` are the same command because `node` is a word
	// stripped before one switch — not a second dispatch that could drift.
	bare, c1 := run(t, bin, nil, "version")
	viaNode, c2 := run(t, bin, nil, "node", "version")
	if c1 != c2 || bare != viaNode {
		t.Fatalf("`apn version` and `apn node version` differ:\n%q (%d)\n%q (%d)", bare, c1, viaNode, c2)
	}
}

func TestHelpShowsBothModes(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "help")
	for _, want := range []string{"Fleet:", "fleet", "node"} {
		if !strings.Contains(out, want) {
			t.Errorf("top-level help should mention %q:\n%s", want, out)
		}
	}
}

func TestFleetHelpExplainsTheCredentialBoundary(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "help", "fleet")
	// The boundary is the thing an operator most needs told, because both modes are reasonably
	// described as "talking to the hub".
	for _, want := range []string{"never falls back", "AGENTPOD_TOKEN", "MACHINE"} {
		if !strings.Contains(out, want) {
			t.Errorf("fleet help should explain %q:\n%s", want, out)
		}
	}
}

func TestUnknownFleetVerbExitsTwo(t *testing.T) {
	bin := build(t)
	_, code := run(t, bin, nil, "fleet", "nonsense")
	if code != 2 {
		t.Fatalf("unknown subcommand should exit 2, got %d", code)
	}
}
