package descriptor

import "testing"

// The report OpenClaw 2026.2.12 prints for `skills list --json`, trimmed to the
// fields a placement reads. Taken from a real run, not invented: the probe row
// is what a fixture placed at ~/.openclaw/skills/<name>/SKILL.md produced.
const openclawSkillReport = `[
 {"name":"sjl-fixture","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
 {"name":"ai-elements","eligible":true,"disabled":false,"blockedByAllowlist":false,"source":"agents-skills-personal","bundled":false},
 {"name":"1password","eligible":false,"disabled":false,"blockedByAllowlist":false,"source":"openclaw-bundled","bundled":true},
 {"name":"muted","eligible":true,"disabled":true,"blockedByAllowlist":false,"source":"openclaw-managed","bundled":false},
 {"name":"blocked","eligible":true,"disabled":false,"blockedByAllowlist":true,"source":"openclaw-managed","bundled":false}
]`

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
	for _, bad := range []string{"", "not json", "{}", "[{\"eligible\":true}]"} {
		listed, err := parseOpenClawSkillReport([]byte(bad))
		if err == nil && len(listed) != 0 {
			t.Errorf("unreadable report %q yielded names: %v", bad, listed)
		}
	}
}
