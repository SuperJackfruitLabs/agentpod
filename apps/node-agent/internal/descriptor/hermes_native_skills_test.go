package descriptor

import "testing"

// The real table, as `hermes -p <profile> skills list` printed it on a live
// node during the probe that established this technique.
const hermesListFixture = `
┌───────────────────┬──────────┬────────┬───────┬──────────┐
│ Name              │ Version  │ Source │ Scope │ State    │
├───────────────────┼──────────┼────────┼───────┼──────────┤
│ sjl-probe-control │          │ local  │ local │ enabled  │
│ something-else    │ 1.2.0    │ hub    │ local │ disabled │
└───────────────────┴──────────┴────────┴───────┴──────────┘
0 hub-installed, 0 builtin, 1 local — 1 enabled, 1 disabled
`

func TestHermesSkillTableReadsNamesAndStates(t *testing.T) {
	listed, err := parseHermesSkillTable([]byte(hermesListFixture))
	if err != nil {
		t.Fatal(err)
	}
	if listed["sjl-probe-control"] != "enabled" {
		t.Fatalf("the published skill was not read as enabled: %+v", listed)
	}
	if listed["something-else"] != "disabled" {
		t.Fatalf("a disabled skill was not read as disabled: %+v", listed)
	}
	if _, ok := listed["Name"]; ok {
		t.Fatal("the table header was read as a skill")
	}
	if len(listed) != 2 {
		t.Fatalf("unexpected rows read: %+v", listed)
	}
}

// A table this parser cannot read must produce no names, so an unreadable
// report can never be mistaken for a skill that is absent or present.
func TestHermesSkillTableYieldsNothingWhenUnreadable(t *testing.T) {
	for _, text := range []string{"", "no table here\nat all\n", "Name Version Source State\nsjl-fixture local enabled\n"} {
		listed, err := parseHermesSkillTable([]byte(text))
		if err != nil {
			t.Fatal(err)
		}
		if len(listed) != 0 {
			t.Fatalf("an unreadable report produced names: %+v", listed)
		}
	}
}

func TestHermesProfileNameRejectsUnusableKeys(t *testing.T) {
	if _, err := hermesProfileName("hermes:coder-kai"); err != nil {
		t.Fatalf("a valid key was rejected: %v", err)
	}
	for _, bad := range []string{"hermes:", "coder-kai", "hermes:../escape", "hermes:with space"} {
		if _, err := hermesProfileName(bad); err == nil {
			t.Fatalf("%q was accepted as a profile key", bad)
		}
	}
}
