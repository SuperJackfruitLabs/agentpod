package descriptor

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/configedit"
)

func applyPlanned(t *testing.T, h *hermesDescriptor, key, id string, v any) (ConfigPlan, ConfigReceipt) {
	t.Helper()
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: id, Value: v}})
	if err != nil {
		t.Fatalf("PlanConfig: %v", err)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	return p, r
}

func TestApplyWritesTheReviewedPlan(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	_, r := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	if len(r.Written) != 1 || r.Written[0].SettingID != "hermes.approvals.timeout" {
		t.Fatalf("written = %#v", r.Written)
	}
	body, _ := os.ReadFile(cfg)
	if !strings.Contains(string(body), "timeout: 900") {
		t.Fatalf("the document was not written:\n%s", body)
	}
}

// This is D8's test.
func TestApplyRefusesAPlanTheDocumentNoLongerMatches(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatal(err)
	}
	// The operator edits the file between review and apply.
	changed := planDoc + "model:\n  context_length: 8000\n"
	if err := os.WriteFile(cfg, []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("a stale plan must be an answer, not an error: %v", err)
	}
	if r.Phase != "conflict" {
		t.Fatalf("phase = %q, want conflict", r.Phase)
	}
	if r.Plan.Refusal == nil || r.Plan.Refusal.Code != "PLAN_STALE" {
		t.Fatalf("refusal = %+v, want PLAN_STALE", r.Plan.Refusal)
	}
	body, _ := os.ReadFile(cfg)
	if string(body) != changed {
		t.Fatal("a REFUSED apply still wrote to the document")
	}
}

func TestApplyRefusesADigestThatWasNeverPlanned(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	if _, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cfg)
	r, err := h.ApplyConfig(context.Background(), key, "op_1", strings.Repeat("f", 64))
	if err == nil && r.Phase == "applied" {
		t.Fatal("a fabricated digest was applied")
	}
	after, _ := os.ReadFile(cfg)
	if string(before) != string(after) {
		t.Fatal("a fabricated digest still wrote to the document")
	}
}

func TestApplyIsIdempotentForTheSameOperation(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, first := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	once, _ := os.ReadFile(cfg)
	second, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("re-apply: %v", err)
	}
	if second.Phase != "applied" {
		t.Fatalf("phase = %q, want applied from the journal", second.Phase)
	}
	twice, _ := os.ReadFile(cfg)
	if string(once) != string(twice) {
		t.Fatal("applying the same operation twice edited the document twice")
	}
	_ = first
}

// Spec §10.1, asserted rather than assumed.
func TestApplyChangesNoKeyOutsideThePlan(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	before, _ := os.ReadFile(cfg)
	applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	after, _ := os.ReadFile(cfg)
	if err := configedit.SameOutsideKeys(before, after,
		[]string{"approvals.timeout"}, nil); err != nil {
		t.Fatalf("an apply changed something outside its plan: %v", err)
	}
	// And D5: the operator's file was not reflowed.
	if !strings.Contains(string(after), "# operator's note") {
		t.Fatal("the operator's comment did not survive the write")
	}
}

// F2, now through the real apply path and onto disk.
func TestApplyOfAnAdditiveOnlySettingKeepsTheOperatorsEntries(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	applyPlanned(t, h, key, "hermes.approvals.command_allowlist", []string{"npm test"})
	body, _ := os.ReadFile(cfg)
	if !strings.Contains(string(body), "ls") {
		t.Fatalf("an additive-only apply removed the operator's grant:\n%s", body)
	}
	if !strings.Contains(string(body), "npm test") {
		t.Fatalf("the declared entry was not added:\n%s", body)
	}
}

// Like the plan-side restart test, this takes its expectation from the
// registry: Task 1 may have settled that approvals.timeout hot-reloads.
// The invariant that does NOT depend on Task 1 is the second half — a
// receipt never claims anything about restarting.
func TestApplyReportsRestartRequiredAndRestartsNothing(t *testing.T) {
	h, key, _ := hermesWithProfile(t, planDoc)
	var want bool
	for _, s := range h.ConfigSettings() {
		if s.ID == "hermes.approvals.timeout" {
			want = s.RestartToTakeEffect
		}
	}
	_, r := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	if r.Plan.RestartRequired != want {
		t.Fatalf("restartRequired = %v, want %v (the registry's value)", r.Plan.RestartRequired, want)
	}
	// The receipt describes a WRITE, never an effect. Spec §10.8 / D4.
	data, _ := json.Marshal(r)
	if strings.Contains(string(data), "restarted") {
		t.Fatalf("the receipt claims something about restarting: %s", data)
	}
}

func TestInspectReturnsTheRecordedReceiptWithoutReplanning(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, _ := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	// Change the document; inspect must still show what was REVIEWED.
	if err := os.WriteFile(cfg, []byte(planDoc), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := h.InspectConfig(context.Background(), key, "op_1")
	if err != nil {
		t.Fatalf("InspectConfig: %v", err)
	}
	if got.Plan.PlanDigest != p.PlanDigest {
		t.Fatal("inspect re-derived the plan instead of returning the reviewed one")
	}
	if _, err := h.InspectConfig(context.Background(), key, "op_nope"); err == nil {
		t.Fatal("an unknown operation id returned a receipt instead of an error")
	}
}

// The absent-key case, all the way onto disk: a fresh station gets its
// additive-only baseline created, the reconcilable setting planned alongside
// it is written too, and the operator's own file is not reflowed.
func TestApplyCreatesAnAbsentAdditiveOnlyKeyAlongsideAScalar(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, freshDoc)
	before, _ := os.ReadFile(cfg)
	p, err := h.PlanConfig(context.Background(), key, "op_1", []DeclaredSetting{
		{SettingID: "hermes.approvals.timeout", Value: 900},
		{SettingID: "hermes.approvals.command_allowlist", Value: []string{"git status"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if p.Refusal != nil {
		t.Fatalf("plan refused: %+v", p.Refusal)
	}
	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("ApplyConfig: %v", err)
	}
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	after, _ := os.ReadFile(cfg)
	body := string(after)
	if !strings.Contains(body, "timeout: 900") {
		t.Fatalf("the scalar was not written:\n%s", body)
	}
	if !strings.Contains(body, "- git status") {
		t.Fatalf("the additive-only key was not created:\n%s", body)
	}
	if !strings.Contains(body, "# operator's note") {
		t.Fatalf("the operator's comment did not survive:\n%s", body)
	}
	if err := configedit.SameOutsideKeys(before, after,
		[]string{"approvals.timeout", "approvals.command_allowlist"},
		map[string][]string{"approvals.command_allowlist": {"git status"}}); err != nil {
		t.Fatalf("the write touched more than its plan: %v", err)
	}
}

// Finding 9: the already-applied early return used to precede the digest
// check, so ANY digest — empty, fabricated — got that receipt back and the
// "proof of review" check was unreachable on the idempotent path. Nothing was
// ever written either way; this is about what the node is willing to say.
func TestApplyChecksTheDigestEvenForAnOperationAlreadyApplied(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	once, _ := os.ReadFile(cfg)

	r, err := h.ApplyConfig(context.Background(), key, "op_1", strings.Repeat("f", 64))
	if err != nil {
		t.Fatalf("a wrong digest must be an answer, not an error: %v", err)
	}
	if r.Phase == "applied" {
		t.Fatal("a fabricated digest was answered with the applied receipt")
	}
	if r.Plan.Refusal == nil || r.Plan.Refusal.Code != "PLAN_DIGEST_MISMATCH" {
		t.Fatalf("refusal = %+v, want PLAN_DIGEST_MISMATCH", r.Plan.Refusal)
	}
	twice, _ := os.ReadFile(cfg)
	if string(once) != string(twice) {
		t.Fatal("a refused re-apply wrote to the document")
	}
}

// End to end on the document adopt-time reconcile actually meets: no
// `approvals:` section at all. The section is appended at the END, so the
// operator's own lines survive unbroken and in order, and the declared value
// is readable afterwards.
func TestApplyCreatesAnAbsentSectionAtTheEndOfTheDocument(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, noSectionDoc)
	_, r := applyPlanned(t, h, key, "hermes.approvals.timeout", 900)
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	body, _ := os.ReadFile(cfg)
	if string(body) != noSectionDoc+"approvals:\n  timeout: 900\n" {
		t.Fatalf("the created section is not the one key at the end:\n%q", string(body))
	}
	v, present, err := configedit.Read(body, "approvals.timeout")
	if err != nil || !present || v != 900 {
		t.Fatalf("approvals.timeout after apply: %#v present=%v err=%v", v, present, err)
	}
}

// The same, for an `additive-only` list — the policy F2 protects. Nothing was
// there to remove, and what lands is exactly what was declared.
func TestApplyCreatesAnAbsentSectionForAnAdditiveOnlyList(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, noSectionDoc)
	_, r := applyPlanned(t, h, key, "hermes.approvals.command_allowlist", []string{"git status"})
	if r.Phase != "applied" {
		t.Fatalf("phase = %q, want applied (error: %q)", r.Phase, r.Error)
	}
	body, _ := os.ReadFile(cfg)
	if string(body) != noSectionDoc+"approvals:\n  command_allowlist:\n    - git status\n" {
		t.Fatalf("the created section is not the one list at the end:\n%q", string(body))
	}
}

// D10's test. The honest seam is the gap ApplyConfig's own algorithm already
// has: between its atomic write landing and the read-back that verifies
// containment (step 5 — see writeAndReadBack). h.afterApplyWriteForTest is
// invoked at exactly that gap, in the real ApplyConfig call, on the real
// filesystem — it lands a second, later write standing in for a concurrent
// edit (e.g. the operator pressing "Allow always" through Hermes' own UI),
// not a sleep-timed guess at when a race might land.
func TestApplyPreservesBothEditsWhenTheDocumentChangesDuringTheWrite(t *testing.T) {
	h, key, cfg := hermesWithProfile(t, planDoc)
	p, err := h.PlanConfig(context.Background(), key, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatal(err)
	}

	// What a concurrent edit lands in the gap between our write and our
	// read-back — standing in for the operator's own, unrelated change.
	raced := planDoc + "model:\n  context_length: 8000\n"
	h.afterApplyWriteForTest = func(path string) {
		if err := os.WriteFile(path, []byte(raced), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	r, err := h.ApplyConfig(context.Background(), key, "op_1", p.PlanDigest)
	if err != nil {
		t.Fatalf("a lost race must be an answer, not an error: %v", err)
	}
	if r.Phase != "conflict" {
		t.Fatalf("phase = %q, want conflict (error: %q)", r.Phase, r.Error)
	}

	// 1. The document is exactly as the race left it: not reverted to the
	// pre-apply original, and not overwritten with our intended edit either.
	body, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != raced {
		t.Fatalf("the document was not left exactly as found:\ngot:  %q\nwant: %q", body, raced)
	}

	// 2. Our intended edit was not discarded: it was saved beside the
	// document, byte-identical to what an UNRACED apply of the very same
	// plan against the very same starting document actually writes — the
	// oracle, not a guess at what the bytes "should" look like.
	h2, key2, cfg2 := hermesWithProfile(t, planDoc)
	p2, err := h2.PlanConfig(context.Background(), key2, "op_1",
		[]DeclaredSetting{{SettingID: "hermes.approvals.timeout", Value: 900}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h2.ApplyConfig(context.Background(), key2, "op_1", p2.PlanDigest); err != nil {
		t.Fatal(err)
	}
	wantSidecar, err := os.ReadFile(cfg2)
	if err != nil {
		t.Fatal(err)
	}

	sidecarPath := cfg + ".agentpod-rejected"
	gotSidecar, err := os.ReadFile(sidecarPath)
	if err != nil {
		t.Fatalf("no sidecar was written at %s: %v", sidecarPath, err)
	}
	if string(gotSidecar) != string(wantSidecar) {
		t.Fatalf("sidecar = %q, want the unraced apply's bytes %q", gotSidecar, wantSidecar)
	}

	// 3. The refusal names both paths.
	if !strings.Contains(r.Error, cfg) {
		t.Fatalf("refusal does not name the document's path %s: %q", cfg, r.Error)
	}
	if !strings.Contains(r.Error, sidecarPath) {
		t.Fatalf("refusal does not name the sidecar's path %s: %q", sidecarPath, r.Error)
	}
	if !strings.Contains(strings.ToLower(r.Error), "lost") {
		t.Fatalf("refusal does not say plainly that neither edit was lost: %q", r.Error)
	}
}
