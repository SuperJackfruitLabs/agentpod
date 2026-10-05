package descriptor

import (
	"context"
	"os"
	"strings"
	"testing"
)

const planDoc = `# operator's note
approvals:
  mode: ask
  timeout: 300
  command_allowlist:
    - ls
`

func planOne(t *testing.T, h *hermesDescriptor, key, id string, v any) ConfigPlan {
	t.Helper()
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: id, Value: v}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	return p
}

func TestPlanAReconcilableSettingNamesTheEditAndWritesNothing(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	before, _ := os.ReadFile(cfg)
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.Refusal != nil {
		t.Fatalf("unexpected refusal: %+v", p.Refusal)
	}
	if len(p.Entries) != 1 || p.Entries[0].Action != "modify" {
		t.Fatalf("entries = %#v", p.Entries)
	}
	if p.Entries[0].Current != 300 || p.Entries[0].Intended != 900 {
		t.Fatalf("current/intended = %#v/%#v", p.Entries[0].Current, p.Entries[0].Intended)
	}
	if p.PlanDigest == "" {
		t.Fatal("a plan with no digest cannot be applied")
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("PlanConfig wrote to the document — planning must write nothing")
	}
}

func TestPlanIsDeterministicForTheSameDocument(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	a := planOne(t, h, key, "hermes.approvals.timeout", 900)
	b := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if a.PlanDigest != b.PlanDigest {
		t.Fatal("two plans of one unchanged document differ — PLAN_STALE would fire on every apply")
	}
}

func TestPlanDigestChangesWhenTheDocumentChanges(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	a := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if err := os.WriteFile(cfg, []byte(planDoc+"model:\n  context_length: 8000\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if a.PlanDigest == b.PlanDigest {
		t.Fatal("the digest ignored a document change — a stale plan would apply silently")
	}
}

func TestPlanRefusesAnUnregisteredSettingByName(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.nope", 1)
	if p.Refusal == nil || p.Refusal.Code != "UNKNOWN_SETTING" {
		t.Fatalf("refusal = %+v, want UNKNOWN_SETTING", p.Refusal)
	}
	if !strings.Contains(p.Refusal.Message, "hermes.approvals.nope") {
		t.Fatalf("a refusal must name the id it refused: %q", p.Refusal.Message)
	}
}

func TestPlanOnAnUnparseableDocumentRefusesWithUnreadable(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n\t\tbroken: [unclosed\n")
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.Refusal == nil || p.Refusal.Code != "UNREADABLE" {
		t.Fatalf("refusal = %+v, want UNREADABLE", p.Refusal)
	}
	if len(p.Entries) != 0 {
		t.Fatal("an unreadable document produced edit entries")
	}
}

func TestPlanOfAnAdditiveOnlySettingPlansAnAppendNotAReplace(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.command_allowlist", []string{"npm test"})
	if len(p.Entries) != 1 || p.Entries[0].Action != "append" {
		t.Fatalf("entries = %#v, want one append", p.Entries)
	}
	got, ok := p.Entries[0].Intended.([]any)
	if !ok {
		t.Fatalf("intended = %#v, want a list", p.Entries[0].Intended)
	}
	var sawLS bool
	for _, v := range got {
		if v == "ls" {
			sawLS = true
		}
	}
	if !sawLS {
		t.Fatal("the intended value dropped the operator's own entry — F2's worst outcome, planned")
	}
}

func TestPlanOfAMatchingValueIsANoOp(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	p := planOne(t, h, key, "hermes.approvals.timeout", 300)
	if !p.NoOp || p.Entries[0].Action != "noop" {
		t.Fatalf("noOp = %v, action = %q", p.NoOp, p.Entries[0].Action)
	}
	if p.RestartRequired {
		t.Fatal("a no-op claimed a restart was required — nothing changed to take effect")
	}
}

// NOTE: this reads the expectation from the registry rather than hardcoding
// `true`. Task 1 may have replaced the unverified assumption with evidence
// that approvals.timeout hot-reloads — in which case a hardcoded `true` here
// would be a test asserting the opposite of the registry it is testing.
func TestPlanCarriesRestartRequiredOnlyForEntriesThatChangeSomething(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	var want bool
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.timeout" {
			want = s.RestartToTakeEffect
		}
	}
	p := planOne(t, h, key, "hermes.approvals.timeout", 900)
	if p.RestartRequired != want {
		t.Fatalf("restartRequired = %v, want %v (the registry's value for this setting)",
			p.RestartRequired, want)
	}
}

func TestPlanRefusesAProfileScopedSettingOnTheCompositeRoot(t *testing.T) {
	h, _, _ := hermesWithProfile(t, planDoc)
	p, err := h.PlanConfig(context.Background(), "hermes", "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal == nil || p.Refusal.Code != "OUT_OF_SCOPE" {
		t.Fatalf("refusal = %+v, want OUT_OF_SCOPE", p.Refusal)
	}
}

// TestPlanRefusesACredentialPath tests the CREDENTIAL_PATH rule directly
// against isCredentialPath, the pure function PlanConfig's first check
// calls, rather than through PlanConfig itself.
//
// The real Hermes registry has no setting whose document resolves to
// anything but config.yaml, so there is no way to make PlanConfig take this
// branch without either inventing a credential-resolving registry entry
// (changing what the real registry can do, which the brief for this task
// forbids) or adding a seam purely to let a test fake one. Testing the
// extracted predicate directly exercises the exact rule PlanConfig applies,
// can actually fail if that rule regresses, and leaves production behaviour
// — and the registry — untouched.
func TestPlanRefusesACredentialPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/home/op/.hermes/profiles/one/auth.json", true},
		{"/home/op/.hermes/.env", true},
		{"/home/op/.hermes/credentials/profile.yaml", true},
		{"/home/op/.hermes/profiles/credentials", true},
		{"/home/op/.hermes/profiles/one/config.yaml", false},
	}
	for _, c := range cases {
		if got := isCredentialPath(c.path); got != c.want {
			t.Errorf("isCredentialPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}
