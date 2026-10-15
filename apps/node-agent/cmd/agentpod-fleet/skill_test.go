package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// registryVerbs is every top-level verb the CLI's own registry (reference.go, which renders
// `fleet help`) lists, minus the empty root entry.
func registryVerbs() []string {
	var out []string
	for _, c := range reference.Commands {
		if c.Path != "" && !strings.Contains(c.Path, " ") {
			out = append(out, c.Path)
		}
	}
	return out
}

// verbsMissingFrom returns the verbs that do not appear as `fleet <verb>` in text.
func verbsMissingFrom(text string, verbs []string) []string {
	var missing []string
	for _, v := range verbs {
		if !regexp.MustCompile("fleet " + regexp.QuoteMeta(v) + `([^a-z-]|$)`).MatchString(text) {
			missing = append(missing, v)
		}
	}
	return missing
}

func safetySection(t *testing.T, text string) string {
	t.Helper()
	i := strings.Index(text, "## Safety")
	j := strings.Index(text, "## Installing this skill")
	if i < 0 || j < i {
		t.Fatal("skill has no Safety section ahead of the install section")
	}
	return text[i:j]
}

// Drift guard: a verb the registry lists but the skill never mentions fails, and so does a verb
// the Safety section never classifies.
func TestSkillMentionsEveryRegistryVerb(t *testing.T) {
	text := skillText("test")
	verbs := registryVerbs()
	if len(verbs) < 15 {
		t.Fatalf("registry yields only %d verbs; the guard is reading the wrong thing", len(verbs))
	}
	if m := verbsMissingFrom(text, verbs); len(m) > 0 {
		t.Errorf("skill/SKILL.md never mentions: %v", m)
	}
	if m := verbsMissingFrom(safetySection(t, text), verbs); len(m) > 0 {
		t.Errorf("skill/SKILL.md Safety section never classifies: %v", m)
	}
}

// Revert-proof: the guard must go red when a verb is added to the registry without a mention.
// (Also verified by hand: deleting `fleet bridge` from SKILL.md made the test above fail.)
func TestSkillDriftGuardCatchesAnUnmentionedVerb(t *testing.T) {
	text := skillText("test")
	added := append(registryVerbs(), "frobnicate")
	m := verbsMissingFrom(text, added)
	if len(m) != 1 || m[0] != "frobnicate" {
		t.Fatalf("guard missed an unmentioned registry verb: %v", m)
	}
	if m := verbsMissingFrom(strings.ReplaceAll(text, "fleet bridge", "fleet brid"), registryVerbs()); len(m) == 0 {
		t.Fatal("guard missed a verb removed from the text")
	}
}

func TestSkillIsStampedAndShapedForClaude(t *testing.T) {
	text := skillText("v9.9.9")
	if strings.Contains(text, skillVersionMarker) {
		t.Error("version marker left unstamped")
	}
	if !strings.Contains(text, "Written for fleet v9.9.9") {
		t.Error("skill does not say which fleet it was written for")
	}
	if !strings.HasPrefix(text, "---\nname: agentpod-fleet\ndescription: ") {
		t.Error("frontmatter missing or wrong name")
	}
}

func TestSkillInstallMatchesPrintedAndIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	path, err := installSkill(dir, "vX")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, "agentpod-fleet", "SKILL.md"); path != want {
		t.Fatalf("path %q, want %q", path, want)
	}
	got, _ := os.ReadFile(path)
	if string(got) != skillText("vX") {
		t.Fatal("installed file differs from `fleet skill` output")
	}
	if _, err := installSkill(dir, "vX"); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(path)
	if string(again) != string(got) {
		t.Fatal("second install changed the file")
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 || entries[0].Name() != "SKILL.md" {
		t.Fatalf("staging file left behind: %v", entries)
	}
	// Overwrites only its own file: a neighbour survives.
	other := filepath.Join(dir, "agentpod-fleet", "NOTES.md")
	os.WriteFile(other, []byte("mine"), 0o644)
	os.WriteFile(path, []byte("stale"), 0o644)
	installSkill(dir, "vX")
	if b, _ := os.ReadFile(other); string(b) != "mine" {
		t.Fatal("install touched a file that is not its own")
	}
	if b, _ := os.ReadFile(path); string(b) != skillText("vX") {
		t.Fatal("install did not replace a stale copy")
	}
}

func TestDefaultSkillDirIsUnderHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	got, err := defaultSkillDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != filepath.Join(home, ".claude", "skills") {
		t.Fatalf("default dir %q is not under HOME", got)
	}
}

func TestRefreshInstalledSkillOnlyWhenAlreadyInstalled(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	run := func(d string) error { calls++; _, err := installSkill(d, "new"); return err }

	attempted, err := refreshInstalledSkill(dir, run)
	if err != nil || attempted || calls != 0 {
		t.Fatalf("refreshed with nothing installed: attempted=%v calls=%d err=%v", attempted, calls, err)
	}
	if _, err := os.Stat(skillPath(dir)); err == nil {
		t.Fatal("refresh created a skill nobody installed")
	}

	installSkill(dir, "old")
	attempted, err = refreshInstalledSkill(dir, run)
	if err != nil || !attempted || calls != 1 {
		t.Fatalf("did not refresh an installed skill: attempted=%v calls=%d err=%v", attempted, calls, err)
	}
	if b, _ := os.ReadFile(skillPath(dir)); string(b) != skillText("new") {
		t.Fatal("installed skill was not brought forward")
	}
}
