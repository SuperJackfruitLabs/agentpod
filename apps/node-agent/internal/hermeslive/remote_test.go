package hermeslive

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var binding = OperationBinding{NodeID: "node-1", StationKey: "hermes:fixture", Harness: "hermes", Plugin: Name}

const (
	opA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	opB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	opC = "cccccccccccccccccccccccccccccccc"
)

func operator(dir string, gate Gate) Operator {
	return Operator{ProfileDir: dir, Binding: binding, Gate: func() Gate { return gate },
		Now: func() time.Time { return time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC) }}
}

func TestOperatorEnablesAndDisablesThroughReviewedPlans(t *testing.T) {
	original := "model: fixture\n"
	dir := profile(t, original)
	op := operator(dir, allowed)

	plan, err := op.Plan(opA, "enable")
	if err != nil || plan.Refusal != nil || plan.FileAction == nil || *plan.FileAction != "add" {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	if !strings.Contains(plan.Config.Diff, "+ ") || len(plan.FileNames) == 0 || !plan.RestartRequired {
		t.Fatalf("review is missing its content: %+v", plan)
	}
	if again, _ := op.Plan(opA, "enable"); again.PlanDigest != plan.PlanDigest {
		t.Fatal("planning the same operation twice gave another plan")
	}
	if _, err := op.Plan(opA, "disable"); err == nil {
		t.Fatal("an operation id was reused for another action")
	}
	if _, err := op.Apply(opA, strings.Repeat("0", 64)); !errors.Is(err, ErrConflict) {
		t.Fatalf("apply with another digest = %v", err)
	}
	receipt, err := op.Apply(opA, plan.PlanDigest)
	if err != nil || receipt.Phase != "applied" || receipt.CompletedAt == nil {
		t.Fatalf("apply = %+v, %v", receipt, err)
	}
	if again, err := op.Apply(opA, plan.PlanDigest); err != nil || again.Phase != "applied" {
		t.Fatalf("a repeated apply is not idempotent: %+v, %v", again, err)
	}

	disable, err := op.Plan(opB, "disable")
	if err != nil || disable.Refusal != nil || disable.Gate != nil {
		t.Fatalf("disable plan = %+v, %v", disable, err)
	}
	if receipt, err := op.Apply(opB, disable.PlanDigest); err != nil || receipt.Phase != "applied" {
		t.Fatalf("disable = %+v, %v", receipt, err)
	}
	if config, _ := os.ReadFile(filepath.Join(dir, "config.yaml")); string(config) != original {
		t.Fatalf("config not restored:\n%s", config)
	}
	if _, err := os.Stat(pluginDir(dir)); !os.IsNotExist(err) {
		t.Fatalf("plugin left behind: %v", err)
	}
	if inspected, err := op.Inspect(opA); err != nil || inspected.Phase != "applied" {
		t.Fatalf("journal lost the enable: %+v, %v", inspected, err)
	}
}

func TestOperatorRecordsARefusalAsAnAnswer(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	op := operator(dir, Gate{Reason: "Hermes 0.30.0 is newer than the newest tested"})
	plan, err := op.Plan(opA, "enable")
	if err != nil || plan.Refusal == nil || !strings.Contains(*plan.Refusal, "newest tested") || plan.RestartRequired {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	receipt, err := op.Inspect(opA)
	if err != nil || receipt.Phase != "conflict" || receipt.Error == nil {
		t.Fatalf("refusal not journaled as a conflict: %+v, %v", receipt, err)
	}
	if again, err := op.Apply(opA, plan.PlanDigest); err != nil || again.Phase != "conflict" {
		t.Fatalf("a refused plan was applied: %+v, %v", again, err)
	}
	if _, err := os.Stat(pluginDir(dir)); !os.IsNotExist(err) {
		t.Fatal("a refused plan wrote files")
	}
	if plan, _ := operator(dir, allowed).Plan(opB, "disable"); plan.Refusal == nil {
		t.Fatal("disable without an apn record was not refused")
	}
}

func TestOperatorRefusesAPlanTheProfileNoLongerMatches(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	op := operator(dir, allowed)
	plan, err := op.Plan(opA, "enable")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte("model: edited\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	receipt, err := op.Apply(opA, plan.PlanDigest)
	if err != nil || receipt.Phase != "conflict" || receipt.Error == nil || !strings.Contains(*receipt.Error, "changed") {
		t.Fatalf("apply over an edited profile = %+v, %v", receipt, err)
	}
	if _, err := os.Stat(pluginDir(dir)); !os.IsNotExist(err) {
		t.Fatal("a stale plan wrote files")
	}

	// A Hermes upgraded after the review is reviewed again, not trusted.
	plan, _ = op.Plan(opB, "enable")
	upgraded := operator(dir, Gate{Allowed: true, Version: "0.21.5", Reason: "fixture"})
	if receipt, err := upgraded.Apply(opB, plan.PlanDigest); err != nil || receipt.Phase != "conflict" {
		t.Fatalf("apply after the gate changed = %+v, %v", receipt, err)
	}
}

func TestOperatorSettlesAnInterruptedApply(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	op := operator(dir, allowed)
	plan, _ := op.Plan(opA, "enable")
	// The change landed but its end was never recorded.
	mustApply(t, ok(t)(PlanEnable(dir, allowed, false)))
	journal := OpenJournal(dir)
	receipt, _ := journal.Read(opA)
	receipt.Phase = "applying"
	if err := journal.Write(receipt); err != nil {
		t.Fatal(err)
	}
	if settled, err := op.Apply(opA, plan.PlanDigest); err != nil || settled.Phase != "applied" {
		t.Fatalf("settled = %+v, %v", settled, err)
	}
	// An interrupted disable whose record is still there did not finish.
	disable, _ := op.Plan(opC, "disable")
	receipt, _ = journal.Read(opC)
	receipt.Phase = "applying"
	_ = journal.Write(receipt)
	if settled, _ := op.Apply(opC, disable.PlanDigest); settled.Phase != "conflict" {
		t.Fatalf("an unfinished disable settled as %q", settled.Phase)
	}
}

func TestJournalKeepsItsBoundByDroppingFinishedOperations(t *testing.T) {
	dir := profile(t, "model: fixture\n")
	journal := OpenJournal(dir)
	id := func(i int) string { return strings.Repeat("0", 28) + hex4(i) }
	for i := 0; i < OperationLimit; i++ {
		phase := "conflict"
		if i == 0 {
			phase = "planned"
		}
		if err := journal.Write(OperationReceipt{Plan: OperationPlan{OperationID: id(i)}, Phase: phase}); err != nil {
			t.Fatal(err)
		}
	}
	if err := journal.Write(OperationReceipt{Plan: OperationPlan{OperationID: opA}, Phase: "planned"}); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(journal.dir)
	if len(entries) != OperationLimit {
		t.Fatalf("journal holds %d entries", len(entries))
	}
	if _, err := journal.Read(id(0)); err != nil {
		t.Fatal("an unfinished operation was dropped")
	}
}

func hex4(i int) string {
	const digits = "0123456789abcdef"
	return string([]byte{digits[i>>12&15], digits[i>>8&15], digits[i>>4&15], digits[i&15]})
}
