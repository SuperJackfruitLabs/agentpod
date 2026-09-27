package gitidentity

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The key a station pushes with.
//
// It lives in the NODE's config directory, never in the station's workspace. A key in the
// workspace is a key an agent can read, print, commit by accident, or carry into a handoff — and
// the workspace is the one directory whose contents leave the machine.

func TestEnsureKeyCreatesAnEd25519KeypairOutsideTheWorkspace(t *testing.T) {
	root := t.TempDir()
	workspace := t.TempDir()

	pub, keyPath, created, err := EnsureKey(root, "station_abc", "hermes:test")
	if err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if !created {
		t.Fatal("first call should report the key as created")
	}
	if !strings.HasPrefix(pub, "ssh-ed25519 ") {
		t.Fatalf("public key is not ed25519: %q", pub)
	}
	if strings.HasPrefix(keyPath, workspace) {
		t.Fatalf("private key landed in the workspace: %s", keyPath)
	}
	if !strings.HasPrefix(keyPath, root) {
		t.Fatalf("private key is outside the node's config root: %s", keyPath)
	}

	info, err := os.Stat(keyPath)
	if err != nil {
		t.Fatalf("stat private key: %v", err)
	}
	// ssh refuses a key others can read, and so should we before ssh has to.
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("private key mode is %o, want 600", perm)
	}
	dir, err := os.Stat(filepath.Dir(keyPath))
	if err != nil {
		t.Fatalf("stat key dir: %v", err)
	}
	if perm := dir.Mode().Perm(); perm != 0o700 {
		t.Fatalf("key directory mode is %o, want 700", perm)
	}
}

func TestEnsureKeyIsIdempotent(t *testing.T) {
	root := t.TempDir()

	first, path1, created1, err := EnsureKey(root, "station_abc", "hermes:test")
	if err != nil {
		t.Fatalf("first EnsureKey: %v", err)
	}
	second, path2, created2, err := EnsureKey(root, "station_abc", "hermes:test")
	if err != nil {
		t.Fatalf("second EnsureKey: %v", err)
	}

	if !created1 || created2 {
		t.Fatalf("created flags wrong: first=%v second=%v", created1, created2)
	}
	// Regenerating would silently orphan the key already registered on forge, which the hub can
	// then never match to this station again.
	if first != second || path1 != path2 {
		t.Fatal("a second call produced a different key")
	}
}

func TestEachStationGetsItsOwnKey(t *testing.T) {
	root := t.TempDir()
	a, _, _, err := EnsureKey(root, "station_a", "hermes:a")
	if err != nil {
		t.Fatal(err)
	}
	b, _, _, err := EnsureKey(root, "station_b", "hermes:b")
	if err != nil {
		t.Fatal(err)
	}
	// One key per station is what makes a station's access withdrawable on its own — the whole
	// reason `estate → docs/2026-09-21-forge.md` §7 argues against a shared account.
	if a == b {
		t.Fatal("two stations share a key")
	}
}

func TestSSHCommandPinsTheKeyAndOffersNothingElse(t *testing.T) {
	got := SSHCommand("/cfg/agentpod-node/git-identities/station_abc")

	for _, want := range []string{
		"-i /cfg/agentpod-node/git-identities/station_abc",
		// Without this, ssh offers every key the agent happens to have — including a developer's
		// own, if one is reachable — and forge refuses the connection after too many failures,
		// with an error that says nothing about which key was wrong.
		"IdentitiesOnly=yes",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("GIT_SSH_COMMAND missing %q: %s", want, got)
		}
	}
}
