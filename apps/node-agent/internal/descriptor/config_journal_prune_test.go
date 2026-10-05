package descriptor

import (
	"fmt"
	"testing"
)

func receiptAt(id, phase, at string) ConfigReceipt {
	return ConfigReceipt{
		Plan:      ConfigPlan{SchemaVersion: 1, OperationID: id},
		Phase:     phase,
		UpdatedAt: at,
	}
}

func TestPruneDropsTheOldestFinishedReceiptsFirst(t *testing.T) {
	entries := map[string]ConfigReceipt{}
	for i := 0; i < configOperationLimit+10; i++ {
		id := fmt.Sprintf("op_%04d", i)
		entries[id] = receiptAt(id, "applied", fmt.Sprintf("2026-10-05T00:%02d:%02dZ", i/60, i%60))
	}
	pruneConfigOperations(entries)
	if len(entries) != configOperationLimit {
		t.Fatalf("len = %d, want %d", len(entries), configOperationLimit)
	}
	// The ten oldest went; the newest stayed.
	if _, ok := entries["op_0000"]; ok {
		t.Fatal("the oldest finished receipt survived the prune")
	}
	if _, ok := entries[fmt.Sprintf("op_%04d", configOperationLimit+9)]; !ok {
		t.Fatal("the newest receipt was pruned")
	}
}

// The asymmetry is the point: a reviewed-but-unapplied plan is the only record
// of what an operator agreed to. Dropping one turns their pending apply into a
// digest mismatch with nothing left to explain it.
func TestPruneNeverDropsAPlanStillAwaitingItsApply(t *testing.T) {
	entries := map[string]ConfigReceipt{}
	for i := 0; i < configOperationLimit+5; i++ {
		id := fmt.Sprintf("op_%04d", i)
		entries[id] = receiptAt(id, "planned", fmt.Sprintf("2026-10-05T00:%02d:%02dZ", i/60, i%60))
	}
	pruneConfigOperations(entries)
	if len(entries) != configOperationLimit+5 {
		t.Fatalf("a pending plan was pruned: len = %d, want %d", len(entries), configOperationLimit+5)
	}
}

func TestPruneKeepsPendingPlansAndTrimsFinishedOnesAroundThem(t *testing.T) {
	entries := map[string]ConfigReceipt{}
	// One very old pending plan, plus enough finished ones to go over.
	entries["op_pending"] = receiptAt("op_pending", "planned", "2020-01-01T00:00:00Z")
	for i := 0; i < configOperationLimit+10; i++ {
		id := fmt.Sprintf("op_%04d", i)
		entries[id] = receiptAt(id, "conflict", fmt.Sprintf("2026-10-05T00:%02d:%02dZ", i/60, i%60))
	}
	pruneConfigOperations(entries)
	if _, ok := entries["op_pending"]; !ok {
		t.Fatal("the oldest entry was pruned even though it was still pending")
	}
	if len(entries) > configOperationLimit {
		t.Fatalf("len = %d, want at most %d", len(entries), configOperationLimit)
	}
}

func TestPruneLeavesASmallJournalAlone(t *testing.T) {
	entries := map[string]ConfigReceipt{"op_1": receiptAt("op_1", "applied", "2026-10-05T00:00:00Z")}
	pruneConfigOperations(entries)
	if len(entries) != 1 {
		t.Fatalf("len = %d, want 1", len(entries))
	}
}
