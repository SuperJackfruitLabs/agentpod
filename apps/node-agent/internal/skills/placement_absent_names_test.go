package skills

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// removedPlacement activates the fixture generation natively and then removes
// it, which is the state a reviewed rollback or deactivation leaves behind.
func removedPlacement(t *testing.T) (*InstallStore, context.Context) {
	t.Helper()
	s := placementFixtureStore(t)
	ctx := context.Background()
	for _, step := range []struct{ id, action string }{
		{strings.Repeat("b", 32), "activate"},
		{strings.Repeat("c", 32), "deactivate"},
	} {
		p, err := s.PlanPlacement(ctx, step.id, step.action)
		if err != nil {
			t.Fatalf("%s plan: %v", step.action, err)
		}
		if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
			t.Fatalf("%s apply: %v", step.action, err)
		}
	}
	verification, err := s.VerifyPlacement(ctx)
	if err != nil || verification.Present.Value == nil || *verification.Present.Value {
		t.Fatalf("fixture is not in the absent state: %+v %v", verification, err)
	}
	return s, ctx
}

func TestAbsentPlacementNamesComeFromTheLastVerifiedGeneration(t *testing.T) {
	s, ctx := removedPlacement(t)
	names, indeterminate, err := s.AbsentPlacementNames(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if indeterminate != "" {
		t.Fatalf("verifiable history reported as indeterminable: %q", indeterminate)
	}
	if strings.Join(names, ",") != "sjl-fixture" {
		t.Fatalf("names = %q, want the last placed generation's skills", names)
	}
}

func TestAbsentPlacementNamesAreIndeterminableWithoutHistory(t *testing.T) {
	s := placementFixtureStore(t)
	names, indeterminate, err := s.AbsentPlacementNames(context.Background())
	if err != nil || len(names) != 0 {
		t.Fatalf("names invented without a native placement history: %q %v", names, err)
	}
	if !strings.Contains(indeterminate, "no previous verified native generation") {
		t.Fatalf("reason does not name the condition: %q", indeterminate)
	}
}

// A generation that can no longer be verified is not a licence to guess: the
// caller must report loading as unknown rather than as a negative.
func TestAbsentPlacementNamesAreIndeterminableWhenTheGenerationCannotBeVerified(t *testing.T) {
	s, ctx := removedPlacement(t)
	head, err := s.placementHead()
	if err != nil || head.Previous == nil {
		t.Fatalf("head: %+v %v", head, err)
	}
	manifest := filepath.Join(s.directory, "generations", head.Previous.Generation, bundleManifestName)
	if err := os.WriteFile(manifest, []byte("not a manifest"), 0600); err != nil {
		t.Fatal(err)
	}
	names, indeterminate, err := s.AbsentPlacementNames(ctx)
	if err != nil || len(names) != 0 {
		t.Fatalf("unverifiable generation still produced names: %q %v", names, err)
	}
	if !strings.Contains(indeterminate, "could not be verified") {
		t.Fatalf("reason does not name the condition: %q", indeterminate)
	}
}

// A present placement reports its own discovery names; this path is only for
// the absent case and must not quietly answer for the present one.
func TestAbsentPlacementNamesDeferToAPresentPlacement(t *testing.T) {
	s := placementFixtureStore(t)
	ctx := context.Background()
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	names, indeterminate, err := s.AbsentPlacementNames(ctx)
	if err != nil || len(names) != 0 {
		t.Fatalf("present placement answered through the absent path: %q %v", names, err)
	}
	if !strings.Contains(indeterminate, "present") {
		t.Fatalf("reason does not name the condition: %q", indeterminate)
	}
}
