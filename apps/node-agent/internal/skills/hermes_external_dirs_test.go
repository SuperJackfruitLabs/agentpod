package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// A profile configuration belongs to its operator. The edit adds one entry and
// leaves comments, key order and every unrelated setting exactly as they were.
func TestExternalDirsRegistrationPreservesTheRestOfTheProfile(t *testing.T) {
	path := writeConfig(t, `# operator's notes, which must survive
model: fixture-model
skills:
  # why this profile keeps template vars on
  template_vars: true
  external_dirs: []
  inline_shell: false
curator:
  enabled: true
`)
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if plan.NoOp || plan.Present || plan.Before == plan.After {
		t.Fatalf("registration reported no change: %+v", plan)
	}
	text := string(proposed)
	for _, keep := range []string{"operator's notes", "why this profile keeps template vars on", "model: fixture-model", "inline_shell: false", "curator:"} {
		if !strings.Contains(text, keep) {
			t.Fatalf("the edit dropped %q:\n%s", keep, text)
		}
	}
	if !strings.Contains(text, "managed-skills") {
		t.Fatalf("the entry was not added:\n%s", text)
	}
	if err := ApplyExternalDirs(plan, proposed); err != nil {
		t.Fatal(err)
	}
	var round struct {
		Skills struct {
			ExternalDirs []string `yaml:"external_dirs"`
			TemplateVars bool     `yaml:"template_vars"`
		} `yaml:"skills"`
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(written, &round); err != nil {
		t.Fatal(err)
	}
	if len(round.Skills.ExternalDirs) != 1 || round.Skills.ExternalDirs[0] != "managed-skills" || !round.Skills.TemplateVars {
		t.Fatalf("written configuration is wrong: %+v", round.Skills)
	}
}

// Registering twice must not append a duplicate, and unregistering returns the
// profile to what it was.
func TestExternalDirsRegistrationIsIdempotentAndReversible(t *testing.T) {
	path := writeConfig(t, "skills:\n  external_dirs: []\n")
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyExternalDirs(plan, proposed); err != nil {
		t.Fatal(err)
	}
	again, _, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if !again.NoOp || !again.Present {
		t.Fatalf("a second registration proposed a change: %+v", again)
	}
	off, offDoc, err := PlanExternalDirs(path, "managed-skills", "unregister")
	if err != nil {
		t.Fatal(err)
	}
	if off.NoOp {
		t.Fatal("unregister found nothing to remove")
	}
	if err := ApplyExternalDirs(off, offDoc); err != nil {
		t.Fatal(err)
	}
	var round struct {
		Skills struct {
			ExternalDirs []string `yaml:"external_dirs"`
		} `yaml:"skills"`
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(written, &round); err != nil {
		t.Fatal(err)
	}
	if len(round.Skills.ExternalDirs) != 0 {
		t.Fatalf("the entry survived removal: %+v", round.Skills.ExternalDirs)
	}
	_ = original
}

// A profile edited between review and application must not be overwritten: the
// operator or Hermes itself may have changed an unrelated setting.
func TestExternalDirsApplyRefusesAStaleReview(t *testing.T) {
	path := writeConfig(t, "skills:\n  external_dirs: []\n")
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("skills:\n  external_dirs: []\n  inline_shell: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ApplyExternalDirs(plan, proposed); err == nil {
		t.Fatal("a stale review overwrote a changed profile")
	}
}

// The document handed to apply must be the one that was reviewed.
func TestExternalDirsApplyRefusesAnUnreviewedDocument(t *testing.T) {
	path := writeConfig(t, "skills:\n  external_dirs: []\n")
	plan, _, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyExternalDirs(plan, []byte("skills:\n  external_dirs: [something-else]\n")); err == nil {
		t.Fatal("a substituted document was applied")
	}
}

// Shapes this node did not write are conflicts, not things to overwrite. And a
// profile with no configuration file is not given one.
func TestExternalDirsRefusesShapesItDidNotWrite(t *testing.T) {
	if _, _, err := PlanExternalDirs(writeConfig(t, "skills: not-a-mapping\n"), "managed-skills", "register"); err == nil {
		t.Fatal("a scalar skills key was accepted")
	}
	if _, _, err := PlanExternalDirs(writeConfig(t, "skills:\n  external_dirs: 3\n"), "managed-skills", "register"); err == nil {
		t.Fatal("a scalar external_dirs was accepted")
	}
	missing := filepath.Join(t.TempDir(), "config.yaml")
	if _, _, err := PlanExternalDirs(missing, "managed-skills", "register"); err == nil {
		t.Fatal("a profile with no configuration was given one")
	}
	if _, _, err := PlanExternalDirs(writeConfig(t, "skills: {}\n"), "/absolute/managed", "register"); err == nil {
		t.Fatal("an absolute entry was accepted")
	}
}

// An explicit null list is the common way an absent list is written.
func TestExternalDirsRegistersIntoAnExplicitNullList(t *testing.T) {
	path := writeConfig(t, "skills:\n  external_dirs:\n")
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	if plan.NoOp {
		t.Fatal("a null list was treated as already registered")
	}
	if err := ApplyExternalDirs(plan, proposed); err != nil {
		t.Fatal(err)
	}
	var round struct {
		Skills struct {
			ExternalDirs []string `yaml:"external_dirs"`
		} `yaml:"skills"`
	}
	written, _ := os.ReadFile(path)
	if err := yaml.Unmarshal(written, &round); err != nil {
		t.Fatal(err)
	}
	if len(round.Skills.ExternalDirs) != 1 {
		t.Fatalf("entry not registered: %+v", round.Skills.ExternalDirs)
	}
}

// The edit must not reflow the file. An operator's profile is theirs; adding
// one entry may add one line and must leave every other byte alone. A
// re-encoding implementation passed the semantic tests above and still
// re-indented every nested sequence in a real profile, which is why this
// compares bytes rather than meaning.
func TestExternalDirsEditChangesOnlyTheLinesItAdds(t *testing.T) {
	body := `model: fixture-model
fallback_providers:
- provider: one
  model: a/b
- provider: two
  model: c/d
skills:
  template_vars: true
  external_dirs: []
tts:
  engine:
    command: /some/path --input {input_path}
`
	path := writeConfig(t, body)
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "register")
	if err != nil {
		t.Fatal(err)
	}
	original := strings.Split(body, "\n")
	edited := strings.Split(string(proposed), "\n")
	// The profile writes an inline list, so the entry joins it in place: one
	// line differs and the file keeps its shape and length.
	if len(edited) != len(original) {
		t.Fatalf("an inline list should not change the line count, %d vs %d:\n%s", len(edited), len(original), proposed)
	}
	var differing int
	for i := range original {
		if original[i] == edited[i] {
			continue
		}
		differing++
		if !strings.Contains(edited[i], "managed-skills") || !strings.Contains(edited[i], "external_dirs") {
			t.Fatalf("a line changed that is not the external_dirs entry:\n  was: %q\n  now: %q", original[i], edited[i])
		}
	}
	if differing != 1 {
		t.Fatalf("expected exactly one differing line, saw %d", differing)
	}
	// The nested sequence under fallback_providers must keep its own
	// indentation rather than being normalised.
	if !strings.Contains(string(proposed), "\n- provider: one\n") {
		t.Fatalf("an unrelated sequence was re-indented:\n%s", proposed)
	}
	_ = plan
}

// Removing the only entry leaves the key present and empty rather than a
// dangling null, so the profile reads the same way it did before registration.
func TestExternalDirsRemovalOfTheOnlyEntryLeavesAnEmptyList(t *testing.T) {
	path := writeConfig(t, "skills:\n  external_dirs:\n    - managed-skills\n  template_vars: true\n")
	plan, proposed, err := PlanExternalDirs(path, "managed-skills", "unregister")
	if err != nil {
		t.Fatal(err)
	}
	if err := ApplyExternalDirs(plan, proposed); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var round struct {
		Skills struct {
			ExternalDirs []string `yaml:"external_dirs"`
			TemplateVars bool     `yaml:"template_vars"`
		} `yaml:"skills"`
	}
	if err := yaml.Unmarshal(written, &round); err != nil {
		t.Fatalf("removal produced invalid YAML: %v\n%s", err, written)
	}
	if len(round.Skills.ExternalDirs) != 0 || !round.Skills.TemplateVars {
		t.Fatalf("removal disturbed the profile: %+v\n%s", round.Skills, written)
	}
}
