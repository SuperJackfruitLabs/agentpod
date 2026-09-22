package skills

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func hermesFixtureArchive(t *testing.T) ([]byte, string) {
	t.Helper()
	data, err := os.ReadFile("testdata/export-hermes.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := os.ReadFile("testdata/exports.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ Harness, ArchiveSHA256, BundleDigest string }
	if err := json.Unmarshal(metadata, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if fixture.Harness == "hermes" {
			return data, fixture.ArchiveSHA256
		}
	}
	t.Fatal("no hermes export fixture")
	return nil, ""
}

// A Hermes station is a profile directory, not a checkout. The store is opened
// as Hermes and the workspace deliberately has no .git: creating one inside a
// user's profile to satisfy a binding is exactly what this must not require.
func hermesPlacementStore(t *testing.T) *InstallStore {
	t.Helper()
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "hermes:fixture", Harness: "hermes", Profile: "fixture", WorkspacePath: t.TempDir()}
	store, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	id := strings.Repeat("a", 32)
	data, pin := hermesFixtureArchive(t)
	if _, err := store.PlanInstall(context.Background(), id, bytes.NewReader(data), pin); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(context.Background(), id, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	return store
}

func TestHermesPlacementBindsAProfileWithoutARepository(t *testing.T) {
	s := hermesPlacementStore(t)
	if _, err := os.Stat(filepath.Join(s.binding.WorkspacePath, ".git")); !os.IsNotExist(err) {
		t.Fatal("the fixture workspace must not be a checkout")
	}
	repo, identity, err := s.placementRepository()
	if err != nil {
		t.Fatalf("a profile workspace could not be bound: %v", err)
	}
	if repo != s.binding.WorkspacePath {
		t.Fatalf("coordination root is not the profile: %q", repo)
	}
	if identity == "" {
		t.Fatal("a binding without an identity cannot detect a replaced profile")
	}

	// The identity must move when the directory is replaced, or a swapped
	// profile would silently inherit another profile's placement.
	replaced := t.TempDir()
	s.binding.WorkspacePath = replaced
	_, other, err := s.placementRepository()
	if err != nil {
		t.Fatal(err)
	}
	if other == identity {
		t.Fatal("a different profile produced the same identity")
	}
}

func TestHermesPlacementPublishesUnderTheManagedExternalDirectory(t *testing.T) {
	s := hermesPlacementStore(t)
	ctx := context.Background()
	target, err := s.placementTarget()
	if err != nil {
		t.Fatal(err)
	}
	// external_dirs points at managed-skills; Hermes then finds each skill
	// directory inside it. The managed directory is separate from the
	// profile's own skills/, which the hermes skills CLI owns.
	if target != "managed-skills/sjl-"+s.binding.Profile {
		t.Fatalf("hermes destination is not the managed external directory: %q", target)
	}
	p, err := s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate")
	if err != nil {
		t.Fatal(err)
	}
	if p.NativeLayout != hermesDirectLayout {
		t.Fatalf("hermes plan did not record its own layout: %q", p.NativeLayout)
	}
	if _, err := s.ApplyPlacement(ctx, p.OperationID, p.PlanDigest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(p.TargetPath, "SKILL.md")); err != nil {
		t.Fatal("hermes entrypoint is not where the external directory scan would find it:", err)
	}
	if _, err := os.Stat(filepath.Join(s.binding.WorkspacePath, "skills")); !os.IsNotExist(err) {
		t.Fatal("published into the profile's own skills directory, which the hermes CLI owns")
	}
}

// A checkout harness must still require a checkout: the non-repository binding
// is for stations that are not source trees, not a general relaxation.
func TestNonRepositoryBindingDoesNotRelaxCheckoutHarnesses(t *testing.T) {
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: t.TempDir()}
	store, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	if _, _, err := store.placementRepository(); err == nil {
		t.Fatal("a codex station bound a workspace with no checkout")
	}
}
