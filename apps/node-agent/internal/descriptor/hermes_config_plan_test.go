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

// The end-to-end determinism test above can pass while the digest is BROKEN:
// CreatedAt is RFC3339, which is second-resolution, so two plans derived in the
// same wall-clock second carry identical timestamps and agree even if the
// timestamp is inside the hash. That was verified empirically during Task 4.
//
// This test closes that gap without a sleep, by asserting the exclusion
// directly: a digest must be invariant to the two fields that are not part of
// what review saw. Task 5 detects a stale plan by re-deriving and comparing
// digests, so an unstable digest would make every apply look like a changed
// document.
func TestDigestIgnoresWhenAndUnderWhichOperationAPlanWasMade(t *testing.T) {
	base := ConfigPlan{
		SchemaVersion: 1,
		OperationID:   "op_1",
		StationKey:    "hermes:one",
		Entries: []ConfigPlanEntry{{
			SettingID: "hermes.approvals.timeout", File: "/x/config.yaml",
			KeyPath: "approvals.timeout", Policy: "reconcilable",
			Current: 300, Intended: 900, Action: "modify", RestartToTakeEffect: true,
		}},
		BeforeSHA256: "a", Diff: "-300\n+900\n", RestartRequired: true,
		CreatedAt: "2026-10-05T00:00:00Z",
	}
	later := base
	later.CreatedAt = "2026-11-30T23:59:59Z"
	later.OperationID = "op_2"

	if configDigestOf(base) != configDigestOf(later) {
		t.Fatal("the digest changed with CreatedAt/OperationID — PLAN_STALE would fire on every apply")
	}

	// And the guarantee that makes the digest worth having: a real change to
	// what review saw MUST change it.
	changed := base
	changed.Entries = []ConfigPlanEntry{{
		SettingID: "hermes.approvals.timeout", File: "/x/config.yaml",
		KeyPath: "approvals.timeout", Policy: "reconcilable",
		Current: 300, Intended: 1200, Action: "modify", RestartToTakeEffect: true,
	}}
	if configDigestOf(base) == configDigestOf(changed) {
		t.Fatal("the digest ignored a changed intended value — a stale plan would apply silently")
	}
}

// freshDoc is a freshly provisioned profile: `approvals` exists, and
// `command_allowlist` does NOT — Hermes writes that key only once an operator
// presses "Allow always". Every other fixture in this file has a populated
// list, which is why the absent-key case went unnoticed.
const freshDoc = `# operator's note
approvals:
  mode: ask
  timeout: 300
`

// The baseline an `additive-only` declaration exists to establish (D2, "the
// fleet guarantees a baseline is present") must be establishable on the
// station state D3 calls the one safe time to write.
func TestPlanCreatesAnAdditiveOnlyKeyThatIsNotInTheDocumentYet(t *testing.T) {
	h, key, _ := hermesWithProfile(t, freshDoc)
	p := planOne(t, h, key, "hermes.approvals.command_allowlist", []string{"git status"})
	if p.Refusal != nil {
		t.Fatalf("refused creating an absent additive-only key: %+v", p.Refusal)
	}
	if len(p.Entries) != 1 || p.Entries[0].Action != "append" {
		t.Fatalf("entries = %#v, want one append", p.Entries)
	}
	if p.Entries[0].Current != nil {
		t.Fatalf("current = %#v, want nothing (the key is not in the document)", p.Entries[0].Current)
	}
	items, ok := p.Entries[0].Intended.([]any)
	if !ok || len(items) != 1 || items[0] != "git status" {
		t.Fatalf("intended = %#v, want [git status]", p.Entries[0].Intended)
	}
	if p.NoOp {
		t.Fatal("creating a key is not a no-op")
	}
}

// The whole-plan consequence, which is what made this severe: one absent
// additive-only key refused the ENTIRE plan (`derivePlanConfig` refuses, it
// does not skip), and `fleet config plan --station ID` plans every declared
// setting at once with no way to narrow it — so an absent `command_allowlist`
// blocked writing `approvals.timeout`, the setting the spec was written for.
func TestAnAbsentAdditiveKeyDoesNotRefuseTheWholePlan(t *testing.T) {
	h, key, _ := hermesWithProfile(t, freshDoc)
	p, err := h.PlanConfig(context.Background(), key, "op_both", []DeclaredSetting{
		{SettingID: "hermes.approvals.timeout", Value: 900},
		{SettingID: "hermes.approvals.command_allowlist", Value: []string{"git status"}},
	})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	if p.Refusal != nil {
		t.Fatalf("the whole plan was refused: %+v", p.Refusal)
	}
	if len(p.Entries) != 2 {
		t.Fatalf("entries = %#v, want both settings", p.Entries)
	}
	for _, e := range p.Entries {
		if e.Action == "noop" {
			t.Fatalf("%s planned nothing: %#v", e.SettingID, e)
		}
	}
}

// Same story for the other "the operator has nothing here" notation.
func TestPlanFillsAnEmptyBlockListWithoutRefusing(t *testing.T) {
	h, key, _ := hermesWithProfile(t, "approvals:\n  timeout: 300\n  command_allowlist:\n")
	p := planOne(t, h, key, "hermes.approvals.command_allowlist", []string{"git status"})
	if p.Refusal != nil {
		t.Fatalf("refused filling an empty block list: %+v", p.Refusal)
	}
	if len(p.Entries) != 1 || p.Entries[0].Action != "append" {
		t.Fatalf("entries = %#v, want one append", p.Entries)
	}
}
