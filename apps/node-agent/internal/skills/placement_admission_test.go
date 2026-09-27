package skills

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/acp"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/terminal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/workspacegate"
)

func assertFreshSessionAdmission(t *testing.T, dir string, blocked bool) {
	t.Helper()
	g := workspacegate.New()
	a, term := acp.NewManagerWithWorkspaces(g), terminal.NewManagerWithWorkspaces(g)
	defer a.Shutdown()
	defer term.Shutdown()
	_, acpErr := a.Open("codex:fixture", "after-restart", []string{"/bin/cat"}, dir, nil)
	_, termErr := term.Open("codex:fixture", "/bin/cat", dir, 80, 24)
	for _, err := range []error{acpErr, termErr} {
		if blocked && !errors.Is(err, workspacegate.ErrRecoveryRequired) {
			t.Fatalf("expected recovery refusal, got %v", err)
		}
		if !blocked && err != nil {
			t.Fatalf("recovered workspace refused: %v", err)
		}
	}
}

func TestInterruptedPublicationBlocksFreshManagersUntilExactRecovery(t *testing.T) {
	for _, point := range []string{"native-admission", "native-journal", "native-publish", "native-receipt", "native-journal-cleared"} {
		t.Run(point, func(t *testing.T) {
			s := placementFixtureStore(t)
			ctx := context.Background()
			p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			s.afterWrite = func(stage string) error {
				if stage == point {
					return errors.New("fixture interruption")
				}
				return nil
			}
			if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, workspacegate.New()); err == nil {
				t.Fatal("missing interruption")
			}
			s.afterWrite = nil
			nested := filepath.Join(s.binding.WorkspacePath, "nested")
			if err := os.Mkdir(nested, 0700); err != nil {
				t.Fatal(err)
			}
			assertFreshSessionAdmission(t, nested, true)
			if _, err := s.VerifyPlacement(ctx); err == nil {
				t.Fatal("fenced publication reported verified")
			}
			if _, err := s.PlanPlacement(ctx, strings.Repeat("c", 32), "deactivate"); err == nil {
				t.Fatal("new plan accepted before recovery")
			}
			if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, strings.Repeat("0", 64), workspacegate.New()); err == nil {
				t.Fatal("unreviewed recovery accepted")
			}
			assertFreshSessionAdmission(t, nested, true)
			if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, workspacegate.New()); err != nil {
				t.Fatal(err)
			}
			assertFreshSessionAdmission(t, nested, false)
			if _, err := s.VerifyPlacement(ctx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAdmissionIntentPinsGenerationBeforeNativeJournalExists(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	s.afterWrite = func(stage string) error {
		if stage == "native-admission" {
			return errors.New("fixture interruption")
		}
		return nil
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("missing admission interruption")
	}
	s.afterWrite = nil
	data, pin := revisedFixture(t)
	id := strings.Repeat("c", 32)
	if _, err := s.PlanInstall(ctx, id, bytes.NewReader(data), pin); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, workspacegate.New()); err != nil {
		t.Fatal("pinned recovery must survive later managed selection:", err)
	}
	v, err := s.VerifyPlacement(ctx)
	if err != nil || !sameGeneration(v.Current, p.After) {
		t.Fatalf("wrong recovered generation: %+v %v", v, err)
	}
}

func TestAdmissionRefusesChangedOrUnownedFence(t *testing.T) {
	for _, content := range []string{"{}", "not JSON", `{"schemaVersion":1,"operationId":"unowned"}`} {
		t.Run(content, func(t *testing.T) {
			s := placementFixtureStore(t)
			ctx := context.Background()
			p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(p.RepositoryPath, workspacegate.RecoveryMarker)
			if err := os.MkdirAll(filepath.Dir(marker), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(marker, []byte(content), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
				t.Fatal("unowned fence overwritten")
			}
			got, err := os.ReadFile(marker)
			if err != nil || string(got) != content {
				t.Fatal("unowned fence changed")
			}
			assertFreshSessionAdmission(t, s.binding.WorkspacePath, true)
		})
	}
}

func TestAdmissionSerializesDifferentNamespacesInOneRepository(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	binding := s.binding
	binding.WorkspacePath = filepath.Join(s.binding.WorkspacePath, "nested")
	binding.WorkspaceIdentity = ""
	if err := os.Mkdir(binding.WorkspacePath, 0700); err != nil {
		t.Fatal(err)
	}
	other, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	planFixtureInstall(t, other, strings.Repeat("c", 32))
	applyFixtureInstall(t, other, strings.Repeat("c", 32))
	p2, err := other.PlanPlacement(ctx, strings.Repeat("d", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	s.afterWrite = func(stage string) error {
		if stage == "native-admission" {
			return errors.New("fixture interruption")
		}
		return nil
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("missing interruption")
	}
	s.afterWrite = nil
	if _, err := other.ApplyPlacement(ctx, p2.OperationID, p2.PlanDigest); err == nil || !strings.Contains(err.Error(), "admission") {
		t.Fatalf("competing namespace admitted: %v", err)
	}
	if _, err := os.Stat(p2.TargetPath); !os.IsNotExist(err) {
		t.Fatal("competing namespace changed native target")
	}
	assertFreshSessionAdmission(t, binding.WorkspacePath, true)
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	assertFreshSessionAdmission(t, binding.WorkspacePath, false)
}

func TestPreflightConflictDoesNotFenceUnchangedWorkspace(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(p.TargetPath, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("unowned native directory accepted")
	}
	assertFreshSessionAdmission(t, s.binding.WorkspacePath, false)
}

func TestCompletedAdmissionCleanupRefusesChangedNativeHead(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	s.afterWrite = func(stage string) error {
		if stage == "native-journal-cleared" {
			return errors.New("fixture interruption")
		}
		return nil
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("missing interruption")
	}
	s.afterWrite = nil
	head, err := s.placementHead()
	if err != nil {
		t.Fatal(err)
	}
	head.OperationID = strings.Repeat("c", 32)
	if err := s.writeJSON("native/head.json", head); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("changed native head cleared recovery admission")
	}
	assertFreshSessionAdmission(t, s.binding.WorkspacePath, true)
}
