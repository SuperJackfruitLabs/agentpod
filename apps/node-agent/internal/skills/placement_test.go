package skills

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func placementFixtureStore(t *testing.T) *InstallStore {
	t.Helper()
	s, _ := testInstallStore(t)
	if err := os.Mkdir(filepath.Join(s.binding.WorkspacePath, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, s, id)
	applyFixtureInstall(t, s, id)
	return s
}
func TestPlacementPublishesAndRecoversNativeDiscoveryDirectory(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	plan, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(plan.TargetPath)); !os.IsNotExist(err) {
		t.Fatal("planning published native root")
	}
	if _, err = s.ApplyPlacement(ctx, plan.OperationID, plan.PlanDigest); err != nil {
		t.Fatal(err)
	}
	initial, err := s.VerifyPlacement(ctx)
	if err != nil || initial.Present.Value == nil || !*initial.Present.Value || initial.Loaded.Value != nil || strings.Join(initial.DiscoveryNames, ",") != "sjl-fixture:sjl-fixture" {
		t.Fatalf("native evidence: %+v %v", initial, err)
	}
	if _, err = s.ApplyPlacement(ctx, plan.OperationID, plan.PlanDigest); err != nil {
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
	updated, err := s.PlanPlacement(ctx, strings.Repeat("d", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, updated.OperationID, updated.PlanDigest); err != nil {
		t.Fatal(err)
	}
	rollback, err := s.PlanPlacement(ctx, strings.Repeat("e", 32), "rollback")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, rollback.OperationID, rollback.PlanDigest); err != nil {
		t.Fatal(err)
	}
	restored, err := s.VerifyPlacement(ctx)
	if err != nil || *restored.Current != *initial.Current {
		t.Fatalf("rollback: %+v %v", restored, err)
	}
	remove, err := s.PlanPlacement(ctx, strings.Repeat("f", 32), "deactivate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, remove.OperationID, remove.PlanDigest); err != nil {
		t.Fatal(err)
	}
	absent, err := s.VerifyPlacement(ctx)
	if err != nil || *absent.Present.Value || len(absent.DiscoveryNames) != 0 {
		t.Fatalf("deactivate: %+v %v", absent, err)
	}
	if _, err = os.Stat(plan.TargetPath); !os.IsNotExist(err) {
		t.Fatal("native target remains")
	}
	managed, err := s.Verify(ctx)
	if err != nil || managed.Current.Generation != id {
		t.Fatal("placement changed the managed head")
	}
}
func TestPlacementRefusesUserFilesAndPostReviewCollisions(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(s.binding.WorkspacePath, ".claude/skills/local/SKILL.md")
	if err = os.MkdirAll(filepath.Dir(other), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(other, []byte("---\nname: sjl-fixture\ndescription: User skill\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("collision accepted")
	}
	if _, err = os.Stat(filepath.Dir(p.TargetPath)); !os.IsNotExist(err) {
		t.Fatal("collision changed native parent")
	}
	if err = os.Remove(other); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(p.TargetPath, "skills/sjl-fixture/SKILL.md")
	if err = os.WriteFile(file, []byte("user edit"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = s.PlanPlacement(ctx, strings.Repeat("c", 32), "deactivate"); err == nil {
		t.Fatal("user edit accepted")
	}
	content, _ := os.ReadFile(file)
	if string(content) != "user edit" {
		t.Fatal("user edit lost")
	}
}

func TestPlacementRejectsStaleManagedHeadAndChangedReview(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, strings.Repeat("f", 64)); err == nil {
		t.Fatal("changed review accepted")
	}
	data, pin := revisedFixture(t)
	id := strings.Repeat("c", 32)
	if _, err = s.PlanInstall(ctx, id, bytes.NewReader(data), pin); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err == nil {
		t.Fatal("stale managed head accepted")
	}
	if _, err = os.Stat(filepath.Dir(p.TargetPath)); !os.IsNotExist(err) {
		t.Fatal("stale plan published content")
	}
}
func TestPlacementRepeatedActivationKeepsRollbackHistory(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	for _, id := range []string{"b", "c"} {
		p, err := s.PlanPlacement(ctx, strings.Repeat(id, 32), "activate")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
			t.Fatal(err)
		}
	}
	p, err := s.PlanPlacement(ctx, strings.Repeat("d", 32), "rollback")
	if err != nil {
		t.Fatal(err)
	}
	if p.After != nil {
		t.Fatal("repeated activation lost original absent state")
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
}
func TestPlacementRejectsUnsupportedHarnessAndUnownedMatchingTarget(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	original := s.binding.Harness
	s.binding.Harness = "claude-code"
	if _, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
		t.Fatal("untested layout accepted")
	}
	s.binding.Harness = original
	target := filepath.Join(s.binding.WorkspacePath, ".agents/skills/sjl-fixture")
	if err := os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
		t.Fatal("unowned empty target accepted")
	}
}
func TestPlacementRejectsSymlinkAndAncestorCollision(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	if err := os.Symlink(t.TempDir(), filepath.Join(s.binding.WorkspacePath, ".agents")); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
		t.Fatal("symlink root accepted")
	}
	if err := os.Remove(filepath.Join(s.binding.WorkspacePath, ".agents")); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(s.binding.WorkspacePath, "packages/web")
	if err := os.MkdirAll(nested, 0700); err != nil {
		t.Fatal(err)
	}
	binding := s.binding
	binding.WorkspacePath = nested
	binding.WorkspaceIdentity = ""
	other, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, other, id)
	applyFixtureInstall(t, other, id)
	user := filepath.Join(s.binding.WorkspacePath, ".pi/skills/user/SKILL.md")
	if err = os.MkdirAll(filepath.Dir(user), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(user, []byte("---\nname: sjl-fixture\ndescription: Parent skill\n---\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = other.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
		t.Fatal("ancestor collision accepted")
	}
}

func TestPlacementDeactivationPreservesUnrelatedAmbiguousSkills(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(s.binding.WorkspacePath, ".pi/skills/user/SKILL.md")
	if err = os.MkdirAll(filepath.Dir(other), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(other, []byte("user draft without frontmatter"), 0600); err != nil {
		t.Fatal(err)
	}
	remove, err := s.PlanPlacement(ctx, strings.Repeat("c", 32), "deactivate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, remove.OperationID, remove.PlanDigest); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(other)
	if err != nil || string(content) != "user draft without frontmatter" {
		t.Fatal("unrelated draft changed")
	}
}
