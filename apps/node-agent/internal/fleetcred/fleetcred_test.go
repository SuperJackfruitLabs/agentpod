package fleetcred

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// withConfigDir points os.UserConfigDir at a temp directory for one test.
func withConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir) // Linux
	t.Setenv("HOME", dir)            // macOS resolves ~/Library/Application Support
	t.Setenv(EnvToken, "")
	return dir
}

// TestNeverReadsTheNodeCredential is the test this package exists for.
//
// `apn` ships fleet verbs in the binary installed on every station. That is only safe because a
// fleet command cannot borrow the machine's identity: a node secret says "I am this host", and
// letting it act on the fleet would be the CLI inventing an escalation no hub guard asked for.
//
// So: a node config sitting right there, fully populated, and Load must still refuse.
func TestNeverReadsTheNodeCredential(t *testing.T) {
	dir := withConfigDir(t)

	// A complete node identity, in the place the node agent really keeps it.
	nodeDir := filepath.Join(dir, "agentpod-node")
	if err := os.MkdirAll(nodeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	nodeCfg := map[string]string{
		"hub":        "https://hub.example",
		"nodeId":     "nod_real",
		"nodeSecret": "a-real-node-secret",
	}
	b, _ := json.Marshal(nodeCfg)
	if err := os.WriteFile(filepath.Join(nodeDir, "config.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := Load()
	if err != ErrNoCredential {
		t.Fatalf("want ErrNoCredential with only a node config present, got cred=%+v err=%v", got, err)
	}
	if strings.Contains(got.Token, "node-secret") {
		t.Fatal("the node secret escaped into a fleet credential")
	}
}

func TestEnvironmentWins(t *testing.T) {
	withConfigDir(t)
	t.Setenv(EnvToken, "  kbn-ish-token  ")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Token != "kbn-ish-token" {
		t.Fatalf("token not trimmed: %q", c.Token)
	}
	if !strings.HasPrefix(c.Source, "env:") {
		t.Fatalf("source should name the environment, got %q", c.Source)
	}
}

func TestSaveLoadForget(t *testing.T) {
	withConfigDir(t)

	if err := Save("tok_abc", "https://hub.example"); err != nil {
		t.Fatal(err)
	}

	// The file holds a credential; it must not be world-readable.
	info, err := os.Stat(Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token file mode = %o, want 600", perm)
	}

	c, err := Load()
	if err != nil || c.Token != "tok_abc" {
		t.Fatalf("round trip failed: %+v %v", c, err)
	}
	if c.Source != Path() {
		t.Fatalf("source should name the file, got %q", c.Source)
	}

	if err := Forget(); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err != ErrNoCredential {
		t.Fatal("Load should refuse after Forget")
	}
	// Twice is not an error: an operator running `logout` again has got what they asked for.
	if err := Forget(); err != nil {
		t.Fatalf("second Forget should be a no-op, got %v", err)
	}
}

func TestStoredFileIsNotUnderTheNodeDirectory(t *testing.T) {
	withConfigDir(t)
	// Separate directories is what stops a future edit reaching the node's secret with a
	// relative path, and lets an operator remove one credential without touching the other.
	if strings.Contains(Path(), "agentpod-node") {
		t.Fatalf("fleet token must not live under the node's config directory: %s", Path())
	}
}

func jwt(t *testing.T, payload map[string]any) string {
	t.Helper()
	b, _ := json.Marshal(payload)
	return "aGVhZGVy." + base64.RawURLEncoding.EncodeToString(b) + ".c2ln"
}

func TestInspectReadsWithoutVerifying(t *testing.T) {
	// Signature is nonsense on purpose: `whoami` reports what the operator is carrying, it does
	// not make an authorization decision. The hub verifies; the CLI must never pre-empt it.
	tok := jwt(t, map[string]any{
		"sub":           "prn_abc",
		"principalKind": "human",
		"exp":           time.Now().Add(time.Hour).Unix(),
	})
	c, err := Inspect(tok)
	if err != nil {
		t.Fatal(err)
	}
	if c.Subject != "prn_abc" || c.PrincipalKind != "human" {
		t.Fatalf("claims not read: %+v", c)
	}
	if c.Expired() {
		t.Fatal("a token an hour from expiry is not expired")
	}
}

func TestInspectDetectsExpiry(t *testing.T) {
	tok := jwt(t, map[string]any{"sub": "prn_x", "exp": time.Now().Add(-time.Minute).Unix()})
	c, err := Inspect(tok)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Expired() {
		t.Fatal("a token that expired a minute ago is expired")
	}
}

func TestInspectTreatsAMissingExpiryAsNotExpired(t *testing.T) {
	// Absence of a claim is not evidence of staleness, and the hub is the authority either way.
	c, err := Inspect(jwt(t, map[string]any{"sub": "prn_x"}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Expired() {
		t.Fatal("no exp claim must not read as expired")
	}
}

func TestInspectRefusesNonJWT(t *testing.T) {
	for _, bad := range []string{"", "not-a-jwt", "only.two"} {
		if _, err := Inspect(bad); err == nil {
			t.Fatalf("Inspect(%q) should fail", bad)
		}
	}
}
