package skills

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplyReviewedRequiresPersistedPlanDigest(t *testing.T) {
	store, _ := testInstallStore(t)
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	receipt, err := store.Operation(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	archive, _, _ := fixtureArchive(t)
	for _, digest := range []string{"", strings.Repeat("b", 64)} {
		if _, err := store.ApplyReviewed(context.Background(), id, digest, bytes.NewReader(archive)); !errors.Is(err, ErrInstallConflict) {
			t.Fatalf("unreviewed plan applied: %v", err)
		}
	}
	status, err := store.Verify(context.Background())
	if err != nil || status.Current != nil {
		t.Fatalf("rejected review changed head: %v", err)
	}
	if result, err := store.ApplyReviewed(context.Background(), id, receipt.Plan.PlanDigest, bytes.NewReader(archive)); err != nil || result.Phase != "applied" {
		t.Fatalf("reviewed apply failed: %v", err)
	}
}

func TestOpenExistingInstallStoreDoesNotInitializeMissingState(t *testing.T) {
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: t.TempDir()}
	if store, err := OpenExistingInstallStore(binding); !errors.Is(err, os.ErrNotExist) {
		if store != nil {
			store.Close()
		}
		t.Fatalf("expected missing store: %v", err)
	}
	entries, err := os.ReadDir(binding.WorkspacePath)
	if err != nil || len(entries) != 0 {
		t.Fatalf("inspection initialized files: %v", err)
	}
	if err := os.Mkdir(filepath.Join(binding.WorkspacePath, ".agentpod-skills"), 0700); err != nil {
		t.Fatal(err)
	}
	if store, err := OpenExistingInstallStore(binding); !errors.Is(err, os.ErrNotExist) {
		if store != nil {
			store.Close()
		}
		t.Fatalf("expected missing namespace: %v", err)
	}
	entries, err = os.ReadDir(filepath.Join(binding.WorkspacePath, ".agentpod-skills"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("inspection initialized namespace: %v", err)
	}
}

func TestExistingInstallInspectionRefusesToRepairMissingLock(t *testing.T) {
	store, _ := testInstallStore(t)
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	existing, err := OpenExistingInstallStore(store.binding)
	if err != nil {
		t.Fatal(err)
	}
	defer existing.Close()
	if _, err := existing.Operation(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := existing.Verify(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(store.directory, "lock")); err != nil {
		t.Fatal(err)
	}
	if _, err := existing.Verify(context.Background()); err == nil {
		t.Fatal("inspection repaired missing lock")
	}
	if _, err := os.Stat(filepath.Join(store.directory, "lock")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("inspection wrote lock")
	}
}
