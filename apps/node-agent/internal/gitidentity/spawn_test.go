package gitidentity

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func staticCommand(env []string) CommandFunc {
	return func(string) ([]string, string, []string, error) {
		return []string{"harness", "acp"}, "/ws", env, nil
	}
}

// The point of the whole feature: the process that runs `git push` has to know which key to use.
func TestWithSSHCommandGivesAProvisionedStationItsKey(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}

	_, _, env, err := WithSSHCommand(root, staticCommand([]string{"FOO=1"}))("hermes:press")
	if err != nil {
		t.Fatalf("WithSSHCommand: %v", err)
	}
	var got string
	for _, e := range env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			got = e
		}
	}
	if got == "" {
		t.Fatalf("no GIT_SSH_COMMAND in %v", env)
	}
	if !strings.Contains(got, filepath.Join(root, "git-identities", "stn_abc")) {
		t.Errorf("GIT_SSH_COMMAND does not name the station's key: %s", got)
	}
	// IdentitiesOnly is what stops ssh offering every other key on the host until forge hangs up.
	if !strings.Contains(got, "IdentitiesOnly=yes") {
		t.Errorf("GIT_SSH_COMMAND lost IdentitiesOnly: %s", got)
	}
	// The descriptor's own environment survives.
	if !contains(env, "FOO=1") {
		t.Errorf("the descriptor's env was dropped: %v", env)
	}
}

// Most stations never get an identity. They must come through completely untouched — a
// GIT_SSH_COMMAND naming a file that is not there fails every push with an opaque ssh error.
func TestWithSSHCommandLeavesAnUnprovisionedStationAlone(t *testing.T) {
	root := t.TempDir()
	_, _, env, err := WithSSHCommand(root, staticCommand([]string{"FOO=1"}))("hermes:other")
	if err != nil {
		t.Fatalf("WithSSHCommand: %v", err)
	}
	if len(env) != 1 || env[0] != "FOO=1" {
		t.Errorf("env = %v, want the descriptor's own env unchanged", env)
	}
}

// A station whose identity was withdrawn is indistinguishable from one that never had one.
func TestWithSSHCommandStopsAfterRemoval(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if err := Remove(root, "stn_abc"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	_, _, env, err := WithSSHCommand(root, staticCommand(nil))("hermes:press")
	if err != nil {
		t.Fatalf("WithSSHCommand: %v", err)
	}
	if len(env) != 0 {
		t.Errorf("env = %v, want nothing after the identity was withdrawn", env)
	}
}

// A sidecar left behind without its key would otherwise produce a command naming a missing file.
func TestWithSSHCommandIgnoresASidecarWithNoKey(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if err := os.Remove(KeyPath(root, "stn_abc")); err != nil {
		t.Fatalf("remove key: %v", err)
	}
	if _, ok := KeyPathForStationKey(root, "hermes:press"); ok {
		t.Error("a sidecar with no key was reported as an identity")
	}
}

// Renaming a station changes its key but not its id. The sidecar has to follow, or the station
// keeps a key it can no longer be matched to.
func TestEnsureKeyFollowsAStationRename(t *testing.T) {
	root := t.TempDir()
	first, _, _, err := EnsureKey(root, "stn_abc", "hermes:press")
	if err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	again, _, created, err := EnsureKey(root, "stn_abc", "hermes:newsroom")
	if err != nil {
		t.Fatalf("EnsureKey after rename: %v", err)
	}
	if created {
		t.Error("a rename minted a new key; the registered one would be orphaned on forge")
	}
	if again != first {
		t.Error("a rename changed the key")
	}
	if _, ok := KeyPathForStationKey(root, "hermes:newsroom"); !ok {
		t.Error("the key is not findable under the station's new key")
	}
	if _, ok := KeyPathForStationKey(root, "hermes:press"); ok {
		t.Error("the key is still findable under the station's old key")
	}
}

// An error from the descriptor is the descriptor's to report; this must not swallow it or paper
// over it with an environment for a harness that is not going to start.
func TestWithSSHCommandPropagatesTheDescriptorsError(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	want := errors.New("no acp adapter for this harness")
	_, _, _, err := WithSSHCommand(root, func(string) ([]string, string, []string, error) {
		return nil, "", nil, want
	})("hermes:press")
	if !errors.Is(err, want) {
		t.Errorf("err = %v, want the descriptor's own error", err)
	}
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}
