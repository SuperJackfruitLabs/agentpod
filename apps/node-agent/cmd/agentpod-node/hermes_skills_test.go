package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hermesProfileFixture(t *testing.T, body string) string {
	t.Helper()
	home := t.TempDir()
	dir := filepath.Join(home, ".hermes", "profiles", "fixture")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", home)
	return filepath.Join(dir, "config.yaml")
}

// Without --apply the command is a review: it prints the change and the
// profile on disk is untouched.
func TestHermesSkillsReviewWritesNothing(t *testing.T) {
	path := hermesProfileFixture(t, "model: fixture\nskills:\n  external_dirs: []\n")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"register", "--profile", "fixture"}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("a review without --apply changed the profile")
	}
	if !strings.Contains(out.String(), "managed-skills") || !strings.Contains(out.String(), "--apply") {
		t.Fatalf("the review did not show the change and how to take it:\n%s", out.String())
	}
}

func TestHermesSkillsRegistersAndReverses(t *testing.T) {
	path := hermesProfileFixture(t, "model: fixture\nskills:\n  external_dirs: []\n  template_vars: true\n")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"register", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("register exit %d: %s", code, errOut.String())
	}
	registered, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(registered), "managed-skills") {
		t.Fatalf("register did not add the entry:\n%s", registered)
	}
	if !strings.Contains(string(registered), "template_vars: true") {
		t.Fatalf("register disturbed an unrelated setting:\n%s", registered)
	}

	out.Reset()
	if code := hermesSkillsCmd([]string{"status", "--profile", "fixture"}, &out, &errOut); code != 0 {
		t.Fatalf("status exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "is registered") {
		t.Fatalf("status did not report the registration:\n%s", out.String())
	}

	out.Reset()
	if code := hermesSkillsCmd([]string{"unregister", "--profile", "fixture", "--apply"}, &out, &errOut); code != 0 {
		t.Fatalf("unregister exit %d: %s", code, errOut.String())
	}
	reversed, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, reversed) {
		t.Fatalf("unregister did not restore the profile:\n--- was ---\n%s\n--- now ---\n%s", original, reversed)
	}
}

// A profile with no configuration is not given one, and the refusal says so
// rather than failing obscurely.
func TestHermesSkillsRefusesAProfileWithNoConfiguration(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	var out, errOut bytes.Buffer
	if code := hermesSkillsCmd([]string{"register", "--profile", "absent", "--apply"}, &out, &errOut); code == 0 {
		t.Fatal("a profile with no configuration was written to")
	}
	if errOut.Len() == 0 {
		t.Fatal("the refusal said nothing")
	}
}

func TestHermesSkillsRejectsUnusableArguments(t *testing.T) {
	var out, errOut bytes.Buffer
	for _, args := range [][]string{
		{},
		{"register"},
		{"register", "--profile", ""},
		{"register", "--profile", "a/b"},
		{"register", "--profile"},
		{"wat", "--profile", "fixture"},
		{"register", "--profile", "fixture", "--unknown"},
	} {
		out.Reset()
		errOut.Reset()
		if code := hermesSkillsCmd(args, &out, &errOut); code == 0 {
			t.Fatalf("%v was accepted", args)
		}
	}
}
