package skills

import (
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

func TestGuardedPlacementWaitsForACPAndTerminalInNestedWorkspace(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	g := workspacegate.New()
	a, term := acp.NewManagerWithWorkspaces(g), terminal.NewManagerWithWorkspaces(g)
	defer a.Shutdown()
	defer term.Shutdown()
	nested := filepath.Join(s.binding.WorkspacePath, "nested")
	if err := os.Mkdir(nested, 0700); err != nil {
		t.Fatal(err)
	}
	child, err := a.Open("codex:fixture", "one", []string{"/bin/cat"}, nested, nil)
	if err != nil {
		t.Fatal(err)
	}
	tty, err := term.Open("codex:fixture", "/bin/cat", nested, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, g); !errors.Is(err, workspacegate.ErrBusy) {
			t.Fatalf("active child allowed publication: %v", err)
		}
		if _, err := os.Stat(p.TargetPath); !os.IsNotExist(err) {
			t.Fatal("blocked publication changed native target")
		}
		if err := a.Close(child.ID()); err != nil {
			t.Fatal(err)
		}
	}
	if err := term.Close(tty.ID); err != nil {
		t.Fatal(err)
	}
	// At the actual transaction hook, both process managers must reject starts.
	checkedPublication := false
	s.afterWrite = func(stage string) error {
		if stage != "native-publish" {
			return nil
		}
		checkedPublication = true
		if _, err := a.Open("codex:fixture", "during", []string{"/bin/cat"}, nested, nil); !errors.Is(err, workspacegate.ErrBusy) {
			t.Errorf("ACP entered during publication: %v", err)
		}
		if _, err := term.Open("codex:fixture", "/bin/cat", nested, 80, 24); !errors.Is(err, workspacegate.ErrBusy) {
			t.Errorf("terminal entered during publication: %v", err)
		}
		return nil
	}
	if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, g); err != nil {
		t.Fatal(err)
	}
	if !checkedPublication {
		t.Fatal("publication boundary was not exercised")
	}
	check, err := s.VerifyPlacement(ctx)
	if err != nil || check.Present.Value == nil || !*check.Present.Value || check.Loaded.Value != nil {
		t.Fatalf("placement evidence: %+v %v", check, err)
	}
	lease, err := g.Exclusive(ctx, s.binding.WorkspacePath)
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
}

func TestGuardedPlacementRefusesNilGuardAndReleasesAfterError(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, p.PlanDigest, nil); err == nil {
		t.Fatal("unguarded apply accepted")
	}
	g := workspacegate.New()
	if _, err := s.ApplyPlacementWhenIdle(ctx, p.OperationID, strings.Repeat("0", 64), g); err == nil {
		t.Fatal("unreviewed digest accepted")
	}
	lease, err := g.Activity(ctx, s.binding.WorkspacePath)
	if err != nil {
		t.Fatal("failed apply leaked exclusive lease:", err)
	}
	lease.Release()
}
