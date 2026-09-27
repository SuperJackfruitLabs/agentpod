package descriptor

import "testing"

// The report OpenClaw 2026.2.12 prints for `skills list --json`, trimmed to the
// fields a placement reads. Taken from a real run, not invented: the probe row
// is what a fixture placed at ~/.openclaw/skills/<name>/SKILL.md produced.
// The report OpenClaw 2026.2.12 prints for `skills list --json`: an OBJECT
// carrying the directories it resolved and the inventory under `skills`, with
// the rows trimmed to the fields a placement reads.
//
// An earlier version of this fixture was a bare array. The rows were real but
// the envelope was invented, so the parser was written against a shape the
// harness never emits and this test passed on both halves of the same mistake.
// The probe row is what a fixture placed at ~/.openclaw/skills/<name>/SKILL.md
// actually produced.
const openclawSkillReport = `{
 "workspaceDir": "/home/u/.openclaw/workspace",
 "managedSkillsDir": "/home/u/.openclaw/skills",
 "skills": [
  {"name":"sjl-fixture","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
  {"name":"ai-elements","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"agents-skills-personal","bundled":false},
  {"name":"1password","eligible":false,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-bundled","bundled":true},
  {"name":"muted","eligible":true,"disabled":true,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
  {"name":"blocked","eligible":true,"disabled":false,"blockedByAllowlist":true,"source":"openclaw-managed","bundled":false}
 ]
}`

func TestParseOpenClawSkillReportSeparatesTheThreeWaysASkillDoesNotLoad(t *testing.T) {
	listed, err := parseOpenClawSkillReport([]byte(openclawSkillReport))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// A placed fixture loads.
	if state, ok := listed["sjl-fixture"]; !ok || state != openclawSkillReady {
		t.Fatalf("placed skill should be ready, got %q ok=%v", state, ok)
	}
	// Each non-loading case keeps its own reason rather than collapsing to
	// "absent" -- a skill present but ineligible, disabled or blocked is not
	// the same claim as a skill that was never placed.
	for name, want := range map[string]string{
		"1password": openclawSkillIneligible,
		"muted":     openclawSkillDisabled,
		"blocked":   openclawSkillBlocked,
	} {
		if state, ok := listed[name]; !ok || state != want {
			t.Errorf("%s: want %q, got %q ok=%v", name, want, state, ok)
		}
	}
	if _, ok := listed["never-placed"]; ok {
		t.Error("a name absent from the report must not appear")
	}
}

// An unreadable report must yield nothing rather than a guess, so a reformatted
// or truncated output can never be read as "the skill is not there".
func TestParseOpenClawSkillReportRefusesUnreadableOutput(t *testing.T) {
	for _, bad := range []string{
		"", "not json",
		"{}",                             // no skills key
		`{"skills":[]}`,                  // an empty inventory is never a working install
		`{"skills":[{"eligible":true}]}`, // a row with no name
		`[{"name":"x","eligible":true}]`, // a bare array is not the shape OpenClaw emits
	} {
		listed, err := parseOpenClawSkillReport([]byte(bad))
		if err == nil && len(listed) != 0 {
			t.Errorf("unreadable report %q yielded names: %v", bad, listed)
		}
	}
}
