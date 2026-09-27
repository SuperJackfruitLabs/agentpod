package workspacegate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRecoveryMarkerBlocksFreshCoordinatorWithoutReadingItsContents(t *testing.T) {
	root := t.TempDir()
	nested := filepath.Join(root, "nested", "workspace")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(root, RecoveryMarker)
	if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
		t.Fatal(err)
	}
	// Existence is sufficient; admission never follows instructions in a marker.
	if err := os.WriteFile(marker, []byte("incomplete or malformed state"), 0600); err != nil {
		t.Fatal(err)
	}
	g := New()
	if _, err := g.Activity(context.Background(), nested); !errors.Is(err, ErrRecoveryRequired) {
		t.Fatalf("restarted coordinator admitted fenced workspace: %v", err)
	}
	p, err := g.Exclusive(context.Background(), root)
	if err != nil {
		t.Fatalf("recovery itself must remain possible: %v", err)
	}
	p.Release()
	other, err := g.Activity(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	other.Release()
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	a, err := g.Activity(context.Background(), nested)
	if err != nil {
		t.Fatalf("failed admission leaked a lease: %v", err)
	}
	a.Release()
}

func TestRecoveryAdmissionRejectsAmbiguousMarkerComponents(t *testing.T) {
	for _, component := range []string{".agentpod-skills", ".agentpod-skills/admission", RecoveryMarker} {
		t.Run(component, func(t *testing.T) {
			root := t.TempDir()
			entry := filepath.Join(root, component)
			if err := os.MkdirAll(filepath.Dir(entry), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), entry); err != nil {
				t.Fatal(err)
			}
			if _, err := New().Activity(context.Background(), root); !errors.Is(err, ErrRecoveryRequired) {
				t.Fatalf("dangling state symlink accepted: %v", err)
			}
		})
	}
}

func TestAdmissionInspectionCreatesNoWorkspaceState(t *testing.T) {
	root := t.TempDir()
	a, err := New().Activity(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	a.Release()
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatalf("admission mutated workspace: %v %v", entries, err)
	}
}
