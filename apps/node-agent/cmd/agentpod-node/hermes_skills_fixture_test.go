package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

// This fixture is the oracle for extracting the skills.external_dirs writer
// (plan Task 2) and for the later fold-in that gives the registry a path to
// the same setting (Task 4): given this profile and this directory, the file
// becomes exactly these bytes. It was recorded here, against the CLI exactly
// as shipped, before any code moved. Recording it after the extraction would
// make it an echo of whatever got built rather than a check against what
// shipped, and the guarantee it exists to provide would be circular.
//
// The profile is deliberately not a minimal one: a leading comment, a nested
// block sequence under an unrelated key, a commented setting inside skills:,
// and a pre-existing external_dirs entry of the operator's own. Every one of
// those must survive byte for byte; D5 is the whole claim being tested here,
// and a fixture with nothing to disturb could not catch a reflow.
//
// The recorded bytes themselves live in `apps/node-agent/testdata/
// hermes-skills-oracle/`, not in a constant here, because Task 4's
// byte-identical test for `hermes.skills.external_dirs` lives in a different
// package (internal/descriptor) and must compare against THESE bytes rather
// than a transcription of them. Two copies of an oracle is two oracles, and
// the one that gets adjusted is whichever is nearer the code being changed.
// The files were written out of the constants that stood here mechanically,
// so they are the same bytes, and this test still asserts them against the
// shipped verb.
const (
	hermesSkillsOracleBefore   = "before.yaml"
	hermesSkillsOracleRegister = "after-register.yaml"
)

// hermesSkillsOracle reads one recorded document. A missing or unreadable
// oracle file is a fatal test failure, never an empty string silently
// compared against an empty document.
func hermesSkillsOracle(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "testdata", "hermes-skills-oracle", name))
	if err != nil {
		t.Fatalf("reading the recorded oracle %s: %v", name, err)
	}
	if len(data) == 0 {
		t.Fatalf("the recorded oracle %s is empty, so it cannot be an oracle", name)
	}
	return string(data)
}

// TestHermesSkillsFixtureByteIdenticalRegister is the oracle's register half:
// registering the managed directory in a profile that already has one entry
// of its own adds exactly one line, in place, and disturbs nothing else.
func TestHermesSkillsFixtureByteIdenticalRegister(t *testing.T) {
	want := hermesSkillsOracle(t, hermesSkillsOracleRegister)
	path := hermesProfileFixture(t, hermesSkillsOracle(t, hermesSkillsOracleBefore))
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"register", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("register did not produce the recorded bytes:\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}

// TestHermesSkillsFixtureByteIdenticalUnregister is the oracle's reverse
// half: unregistering from the registered profile returns it to exactly the
// bytes it started from, operator's own entry and all.
func TestHermesSkillsFixtureByteIdenticalUnregister(t *testing.T) {
	want := hermesSkillsOracle(t, hermesSkillsOracleBefore)
	path := hermesProfileFixture(t, hermesSkillsOracle(t, hermesSkillsOracleRegister))
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"unregister", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("unregister did not restore the recorded bytes:\n--- want ---\n%s\n--- got ---\n%s", want, got)
	}
}
