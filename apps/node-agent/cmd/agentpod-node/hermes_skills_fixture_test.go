package main

import (
	"bytes"
	"os"
	"testing"
)

// This fixture is the oracle for extracting the skills.external_dirs writer
// (plan Task 2) and for the later fold-in that gives the registry a path to
// the same setting (Task 4): given this profile and this directory, the file
// becomes exactly these bytes. It is recorded here, against the CLI exactly
// as shipped, before any code moves. Recording it after the extraction would
// make it an echo of whatever got built rather than a check against what
// shipped, and the guarantee it exists to provide would be circular.
//
// The profile is deliberately not a minimal one: a leading comment, a nested
// block sequence under an unrelated key, a commented setting inside skills:,
// and a pre-existing external_dirs entry of the operator's own. Every one of
// those must survive byte for byte; D5 is the whole claim being tested here,
// and a fixture with nothing to disturb could not catch a reflow.
const hermesSkillsFixtureBefore = `# operator's own notes, which must survive
model: fixture-model
fallback_providers:
  - provider: one
    model: a/b
skills:
  # why this profile keeps template vars on
  template_vars: true
  external_dirs:
    - operator-own-dir
curator:
  enabled: true
`

const hermesSkillsFixtureAfterRegister = `# operator's own notes, which must survive
model: fixture-model
fallback_providers:
  - provider: one
    model: a/b
skills:
  # why this profile keeps template vars on
  template_vars: true
  external_dirs:
    - operator-own-dir
    - managed-skills
curator:
  enabled: true
`

// TestHermesSkillsFixtureByteIdenticalRegister is the oracle's register half:
// registering the managed directory in a profile that already has one entry
// of its own adds exactly one line, in place, and disturbs nothing else.
func TestHermesSkillsFixtureByteIdenticalRegister(t *testing.T) {
	path := hermesProfileFixture(t, hermesSkillsFixtureBefore)
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"register", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != hermesSkillsFixtureAfterRegister {
		t.Fatalf("register did not produce the recorded bytes:\n--- want ---\n%s\n--- got ---\n%s",
			hermesSkillsFixtureAfterRegister, got)
	}
}

// TestHermesSkillsFixtureByteIdenticalUnregister is the oracle's reverse
// half: unregistering from the registered profile returns it to exactly the
// bytes it started from, operator's own entry and all.
func TestHermesSkillsFixtureByteIdenticalUnregister(t *testing.T) {
	path := hermesProfileFixture(t, hermesSkillsFixtureAfterRegister)
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"unregister", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != hermesSkillsFixtureBefore {
		t.Fatalf("unregister did not restore the recorded bytes:\n--- want ---\n%s\n--- got ---\n%s",
			hermesSkillsFixtureBefore, got)
	}
}
