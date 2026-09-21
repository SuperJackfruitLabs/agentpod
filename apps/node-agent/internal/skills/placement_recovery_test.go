package skills

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlacementCrashHelper(t *testing.T) {
	if os.Getenv("SJL_PLACEMENT_CRASH_HELPER") != "1" {
		return
	}
	s, err := OpenExistingInstallStore(InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: os.Getenv("SJL_PLACEMENT_CRASH_WORKSPACE")})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.afterWrite = func(point string) error {
		if point == os.Getenv("SJL_PLACEMENT_CRASH_POINT") {
			os.Exit(91)
		}
		return nil
	}
	if _, err = s.ApplyPlacement(context.Background(), strings.Repeat("d", 32), os.Getenv("SJL_PLACEMENT_CRASH_DIGEST")); err != nil {
		t.Fatal(err)
	}
}
func TestPlacementRecoversProcessExitAcrossNativeSwitch(t *testing.T) {
	for _, point := range []string{"native-admission", "native-journal", "file-open", "file-write", "native-stage", "native-backup", "native-publish", "native-head", "native-receipt", "native-journal-cleared"} {
		t.Run(point, func(t *testing.T) {
			s := placementFixtureStore(t)
			ctx := context.Background()
			first, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.ApplyPlacement(ctx, first.OperationID, first.PlanDigest); err != nil {
				t.Fatal(err)
			}
			data, pin := revisedFixture(t)
			id := strings.Repeat("c", 32)
			if _, err = s.PlanInstall(ctx, id, bytes.NewReader(data), pin); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			p, err := s.PlanPlacement(ctx, strings.Repeat("d", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestPlacementCrashHelper$")
			cmd.Env = append(os.Environ(), "SJL_PLACEMENT_CRASH_HELPER=1", "SJL_PLACEMENT_CRASH_WORKSPACE="+s.binding.WorkspacePath, "SJL_PLACEMENT_CRASH_POINT="+point, "SJL_PLACEMENT_CRASH_DIGEST="+p.PlanDigest)
			output, err := cmd.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 91 {
				t.Fatalf("process did not exit at %s: %v %s", point, err, output)
			}
			assertFreshSessionAdmission(t, s.binding.WorkspacePath, true)
			if _, err = s.VerifyPlacement(ctx); err == nil {
				t.Fatal("incomplete native publication reported success")
			}
			if _, err = s.PlanPlacement(ctx, strings.Repeat("e", 32), "deactivate"); err == nil {
				t.Fatal("second native operation accepted before recovery")
			}
			if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
				t.Fatal(err)
			}
			assertFreshSessionAdmission(t, s.binding.WorkspacePath, false)
			verified, err := s.VerifyPlacement(ctx)
			if err != nil || verified.Current == nil || verified.Current.Generation != id {
				t.Fatalf("native recovery failed: %+v %v", verified, err)
			}
			old := filepath.Join(s.directory, "native/backups", p.OperationID, "SKILL.md")
			if _, err = os.Stat(old); err != nil {
				t.Fatal("old native content lost", err)
			}
		})
	}
}

func TestCodexLegacyMigrationRecoversAfterBackup(t *testing.T) {
	s := legacyCodexPlacement(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	s.afterWrite = func(point string) error {
		if point == "native-backup" {
			return errors.New("fixture interruption")
		}
		return nil
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("migration interruption was not observed")
	}
	s.afterWrite = nil
	if _, err := s.VerifyPlacement(ctx); err == nil {
		t.Fatal("partially migrated directory was accepted")
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal("migration recovery failed:", err)
	}
	verified, err := s.VerifyPlacement(ctx)
	if err != nil || verified.Present.Value == nil || !*verified.Present.Value || strings.Join(verified.DiscoveryNames, ",") != "sjl-fixture" {
		t.Fatalf("migration recovery evidence: %+v %v", verified, err)
	}
}
func TestPlacementRecoveryPreservesEditedBackupAndStaging(t *testing.T) {
	for _, point := range []string{"native-stage", "native-backup"} {
		t.Run(point, func(t *testing.T) {
			s := placementFixtureStore(t)
			ctx := context.Background()
			first, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.ApplyPlacement(ctx, first.OperationID, first.PlanDigest); err != nil {
				t.Fatal(err)
			}
			data, pin := revisedFixture(t)
			id := strings.Repeat("c", 32)
			if _, err = s.PlanInstall(ctx, id, bytes.NewReader(data), pin); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			p, err := s.PlanPlacement(ctx, strings.Repeat("d", 32), "activate")
			if err != nil {
				t.Fatal(err)
			}
			s.afterWrite = func(name string) error {
				if name == point {
					return errors.New("fixture interruption")
				}
				return nil
			}
			if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
				t.Fatal("interruption did not happen")
			}
			s.afterWrite = nil
			directory := "staging"
			if point == "native-backup" {
				directory = "backups"
			}
			file := filepath.Join(s.directory, "native", directory, p.OperationID, "SKILL.md")
			if err = os.WriteFile(file, []byte("preserved user edit"), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
				t.Fatal("recovery overwrote edit")
			}
			assertFreshSessionAdmission(t, s.binding.WorkspacePath, true)
			content, _ := os.ReadFile(file)
			if string(content) != "preserved user edit" {
				t.Fatal("edit was lost")
			}
		})
	}
}

func TestPlacementCompletedReceiptCleanupPreservesLaterUserEdits(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	s.afterWrite = func(point string) error {
		if point == "native-receipt" {
			return errors.New("exit after durable completion")
		}
		return nil
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("completion interruption missing")
	}
	s.afterWrite = nil
	original, err := s.PlacementOperation(ctx, p.OperationID)
	if err != nil || original.Phase != "applied" {
		t.Fatal("completion receipt missing", err)
	}
	file := filepath.Join(p.TargetPath, "SKILL.md")
	if err = os.WriteFile(file, []byte("later user edit"), 0600); err != nil {
		t.Fatal(err)
	}
	replay, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest)
	if err != nil {
		t.Fatal("historical completion replay failed", err)
	}
	if replay.CompletedAt == nil || *replay.CompletedAt != *original.CompletedAt {
		t.Fatal("historical completion changed")
	}
	if _, err = s.PlacementOperation(ctx, p.OperationID); err != nil {
		t.Fatal("operation became invalid", err)
	}
	if _, err = s.VerifyPlacement(ctx); err == nil {
		t.Fatal("fresh verification accepted changed files")
	}
	if active, err := s.activePlacement(); err != nil || active != "" {
		t.Fatal("completed journal still blocks inspection", err)
	}
	content, _ := os.ReadFile(file)
	if string(content) != "later user edit" {
		t.Fatal("user edit lost")
	}
}
