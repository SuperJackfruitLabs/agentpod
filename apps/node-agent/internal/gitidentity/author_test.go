package gitidentity

import (
	"os"
	"strings"
	"testing"
)

var fixtureAuthor = Author{Name: "Fixture Agent", Email: "fixture-agent@agents.example"}

// What the hub said the station's commits are by has to survive to the spawn path, which reads it
// from disk on every harness start — possibly after the node restarted.
func TestRecordAuthorRoundTripsThroughTheSidecar(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if err := RecordAuthor(root, "stn_abc", fixtureAuthor); err != nil {
		t.Fatalf("RecordAuthor: %v", err)
	}
	id, ok := IdentityForStationKey(root, "hermes:press")
	if !ok {
		t.Fatal("no identity for a provisioned station")
	}
	if id.Author == nil || *id.Author != fixtureAuthor {
		t.Errorf("author = %+v, want %+v", id.Author, fixtureAuthor)
	}
	if id.KeyPath != KeyPath(root, "stn_abc") {
		t.Errorf("key path = %s", id.KeyPath)
	}
}

// An identity provisioned before authors existed has a key and no author. It must still push.
func TestAnIdentityWithoutAnAuthorStillHasItsKey(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	id, ok := IdentityForStationKey(root, "hermes:press")
	if !ok {
		t.Fatal("no identity for a provisioned station")
	}
	if id.Author != nil {
		t.Errorf("author = %+v, want none", id.Author)
	}
}

// An author for a station with no key would be written for nothing — the spawn path finds a
// station by its key — and would linger after the key was removed.
func TestRecordAuthorRefusesAStationWithNoKey(t *testing.T) {
	root := t.TempDir()
	if err := RecordAuthor(root, "stn_none", fixtureAuthor); err == nil {
		t.Fatal("recorded an author for a station that has no key")
	}
}

// Half an author is attributed to nobody, and a newline or angle bracket in a git ident is either
// rejected by git or silently rewritten into something else.
func TestRecordAuthorRefusesAMalformedAuthor(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	for _, a := range []Author{
		{Name: "", Email: "x@agents.example"},
		{Name: "Fixture Agent", Email: ""},
		{Name: "Fixture\nAgent", Email: "x@agents.example"},
		{Name: "Fixture <Agent>", Email: "x@agents.example"},
		{Name: "Fixture Agent", Email: "x@agents.example>"},
	} {
		if err := RecordAuthor(root, "stn_abc", a); err == nil {
			t.Errorf("accepted %+v", a)
		}
	}
}

// Withdrawal takes the author with it, so a reassigned station cannot commit as its previous agent.
func TestRemoveDeletesTheAuthor(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if err := RecordAuthor(root, "stn_abc", fixtureAuthor); err != nil {
		t.Fatalf("RecordAuthor: %v", err)
	}
	if err := Remove(root, "stn_abc"); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(authorFile(root, "stn_abc")); !os.IsNotExist(err) {
		t.Errorf("author sidecar survived removal: %v", err)
	}
}

// The four variables, with exactly the recorded values, beside the key.
func TestEnvCarriesTheAuthorAndCommitter(t *testing.T) {
	root := t.TempDir()
	if _, _, _, err := EnsureKey(root, "stn_abc", "hermes:press"); err != nil {
		t.Fatalf("EnsureKey: %v", err)
	}
	if err := RecordAuthor(root, "stn_abc", fixtureAuthor); err != nil {
		t.Fatalf("RecordAuthor: %v", err)
	}
	env := Env(root, "hermes:press")
	for _, want := range []string{
		"GIT_AUTHOR_NAME=Fixture Agent",
		"GIT_AUTHOR_EMAIL=fixture-agent@agents.example",
		"GIT_COMMITTER_NAME=Fixture Agent",
		"GIT_COMMITTER_EMAIL=fixture-agent@agents.example",
	} {
		if !contains(env, want) {
			t.Errorf("env lacks %s: %v", want, env)
		}
	}
	if !hasPrefix(env, "GIT_SSH_COMMAND=") {
		t.Errorf("env lacks GIT_SSH_COMMAND: %v", env)
	}
}

func TestEnvIsEmptyForAStationWithNoIdentity(t *testing.T) {
	if env := Env(t.TempDir(), "hermes:other"); len(env) != 0 {
		t.Errorf("env = %v, want nothing", env)
	}
}

func hasPrefix(list []string, prefix string) bool {
	for _, s := range list {
		if strings.HasPrefix(s, prefix) {
			return true
		}
	}
	return false
}
