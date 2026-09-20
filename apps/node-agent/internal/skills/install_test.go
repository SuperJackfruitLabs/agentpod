package skills

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func revisedFixture(t *testing.T) ([]byte, string) {
	t.Helper()
	original, pin, _ := fixtureArchive(t)
	artifact, err := ReadArtifact(context.Background(), bytes.NewReader(original), pin, "codex")
	if err != nil {
		t.Fatal(err)
	}
	revisedHash := hashBytes(append(artifact.Files["skills/sjl-fixture/SKILL.md"], []byte("\nSynthetic revision two.\n")...))
	data := rewriteArchive(t, original, func(header *tar.Header, data []byte) (*tar.Header, []byte) {
		if header.Name == "sjl-fixture/skills/sjl-fixture/SKILL.md" {
			data = append(data, []byte("\nSynthetic revision two.\n")...)
			revisedHash = hashBytes(data)
		}
		if header.Name == "sjl-fixture/sjl-bundle.json" {
			var manifest map[string]any
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.UseNumber()
			if err := decoder.Decode(&manifest); err != nil {
				t.Fatal(err)
			}
			manifest["files"].(map[string]any)["skills/sjl-fixture/SKILL.md"].(map[string]any)["sha256"] = revisedHash
			manifest["version"] = "0.2.0-fixture"
			delete(manifest, "digest")
			encoded, err := libraryJSON(manifest)
			if err != nil {
				t.Fatal(err)
			}
			manifest["digest"] = hashBytes(encoded)
			data, err = libraryJSON(manifest)
			if err != nil {
				t.Fatal(err)
			}
		}
		return header, data
	})
	return data, hashBytes(data)
}

func TestInstallUpgradeAndRollbackPreserveBothGenerations(t *testing.T) {
	store, _ := testInstallStore(t)
	ctx := context.Background()
	a, b, c := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("c", 32)
	planFixtureInstall(t, store, a)
	applyFixtureInstall(t, store, a)
	initial, _ := store.Verify(ctx)
	data, pin := revisedFixture(t)
	plan, err := store.PlanInstall(ctx, b, bytes.NewReader(data), pin)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(plan.Changes.Changed, ","), bundleManifestName) {
		t.Fatal("review diff omits package manifest")
	}
	if _, err := store.Apply(ctx, b, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	updated, _ := store.Verify(ctx)
	if *updated.Path == *initial.Path {
		t.Fatal("upgrade overwrote previous generation")
	}
	rollback, err := store.PlanRollback(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if *rollback.After != *initial.Current {
		t.Fatal("rollback does not bind prior generation")
	}
	if _, err := store.Apply(ctx, c, nil); err != nil {
		t.Fatal(err)
	}
	current, err := store.Verify(ctx)
	if err != nil || *current.Current != *initial.Current {
		t.Fatalf("rollback failed: %v", err)
	}
	if _, err := os.Stat(*updated.Path); err != nil {
		t.Fatal("new generation was discarded")
	}
}

func TestInstallCrashHelper(t *testing.T) {
	if os.Getenv("SJL_INSTALL_CRASH_HELPER") != "1" {
		return
	}
	if os.Getenv("SJL_INSTALL_CRASH_POINT") == "initialize" {
		_, err := openInstallStore(InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: os.Getenv("SJL_INSTALL_CRASH_WORKSPACE")}, func() error { os.Exit(91); return nil })
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	store, err := OpenInstallStore(InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: os.Getenv("SJL_INSTALL_CRASH_WORKSPACE")})
	if err != nil {
		t.Fatal(err)
	}
	store.afterWrite = func(point string) error {
		if point == os.Getenv("SJL_INSTALL_CRASH_POINT") {
			os.Exit(91)
		}
		return nil
	}
	data, _, _ := fixtureArchive(t)
	if _, err := store.Apply(context.Background(), strings.Repeat("a", 32), bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
}

func TestInstallInitializationCrashDoesNotClaimNamespace(t *testing.T) {
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: t.TempDir()}
	command := exec.Command(os.Args[0], "-test.run=^TestInstallCrashHelper$")
	command.Env = append(os.Environ(), "SJL_INSTALL_CRASH_HELPER=1", "SJL_INSTALL_CRASH_POINT=initialize", "SJL_INSTALL_CRASH_WORKSPACE="+binding.WorkspacePath)
	output, err := command.CombinedOutput()
	var exited *exec.ExitError
	if !errors.As(err, &exited) || exited.ExitCode() != 91 {
		t.Fatalf("initialization crash did not occur: %v %s", err, output)
	}
	store, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	applyFixtureInstall(t, store, id)
}

func TestInstallRecoversActualProcessExit(t *testing.T) {
	for _, point := range []string{"file-open", "file-write", "generation", "head"} {
		t.Run(point, func(t *testing.T) {
			store, binding := testInstallStore(t)
			id := strings.Repeat("a", 32)
			planFixtureInstall(t, store, id)
			command := exec.Command(os.Args[0], "-test.run=^TestInstallCrashHelper$")
			command.Env = append(os.Environ(), "SJL_INSTALL_CRASH_HELPER=1", "SJL_INSTALL_CRASH_POINT="+point, "SJL_INSTALL_CRASH_WORKSPACE="+binding.WorkspacePath)
			output, err := command.CombinedOutput()
			var exited *exec.ExitError
			if !errors.As(err, &exited) || exited.ExitCode() != 91 {
				t.Fatalf("crash helper did not interrupt: %v %s", err, output)
			}
			applyFixtureInstall(t, store, id)
			if _, err := store.Verify(context.Background()); err != nil {
				t.Fatal(err)
			}
			if point == "file-open" || point == "file-write" {
				entries, err := os.ReadDir(filepath.Join(store.directory, "pending"))
				if err != nil || len(entries) != 1 {
					t.Fatalf("interrupted write was not retained: %v", err)
				}
			}
		})
	}
}

func TestInstallPreservesEditedStaging(t *testing.T) {
	store, _ := testInstallStore(t)
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	store.afterWrite = func(point string) error {
		if point == "generation" {
			return errors.New("interrupted")
		}
		return nil
	}
	data, _, _ := fixtureArchive(t)
	store.Apply(context.Background(), id, bytes.NewReader(data))
	store.afterWrite = nil
	file := filepath.Join(store.directory, "generations", id, "skills/sjl-fixture/SKILL.md")
	if err := os.WriteFile(file, []byte("edit preserved"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(context.Background(), id, bytes.NewReader(data)); err == nil {
		t.Fatal("edited staged generation applied")
	}
	actual, _ := os.ReadFile(file)
	if string(actual) != "edit preserved" {
		t.Fatal("edit lost during recovery")
	}
}

func testInstallStore(t *testing.T) (*InstallStore, InstallBinding) {
	t.Helper()
	binding := InstallBinding{NodeID: "fixture-node", StationKey: "codex:fixture", Harness: "codex", Profile: "fixture", WorkspacePath: t.TempDir()}
	store, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store, binding
}
func planFixtureInstall(t *testing.T, store *InstallStore, id string) InstallPlan {
	t.Helper()
	data, pin, _ := fixtureArchive(t)
	plan, err := store.PlanInstall(context.Background(), id, bytes.NewReader(data), pin)
	if err != nil {
		t.Fatal(err)
	}
	return plan
}
func applyFixtureInstall(t *testing.T, store *InstallStore, id string) InstallReceipt {
	t.Helper()
	data, _, _ := fixtureArchive(t)
	receipt, err := store.Apply(context.Background(), id, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}
func TestInstallApplyVerifyRollbackAndReplay(t *testing.T) {
	store, binding := testInstallStore(t)
	ctx := context.Background()
	id := strings.Repeat("a", 32)
	userFile := filepath.Join(binding.WorkspacePath, "user.txt")
	os.WriteFile(userFile, []byte("keep"), 0600)
	plan := planFixtureInstall(t, store, id)
	if plan.TargetPath == nil || plan.Binding.WorkspaceIdentity == "" || plan.Before != nil || len(plan.Changes.Added) == 0 || plan.Activation != "pending" {
		t.Fatal("plan lacks binding or diff")
	}
	receipt := applyFixtureInstall(t, store, id)
	if receipt.Phase != "applied" || receipt.CompletedAt == nil {
		t.Fatal("no durable receipt")
	}
	verified, err := store.Verify(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Current == nil || verified.Present.Value == nil || !*verified.Present.Value || verified.Loaded.Value != nil {
		t.Fatal("presence and loading were conflated")
	}
	rollbackID := strings.Repeat("b", 32)
	rollback, err := store.PlanRollback(ctx, rollbackID)
	if err != nil {
		t.Fatal(err)
	}
	if rollback.After != nil {
		t.Fatal("initial rollback should restore absence")
	}
	if _, err := store.Apply(ctx, rollbackID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, id, nil); err != nil {
		t.Fatal(err)
	} // historical replay must not reinstall
	verified, err = store.Verify(ctx)
	if err != nil || verified.Current != nil {
		t.Fatalf("replay altered current installation: %v", err)
	}
	data, _ := os.ReadFile(userFile)
	if string(data) != "keep" {
		t.Fatal("unowned file changed")
	}
}
func TestInstallRefusesStalePlansAndEdits(t *testing.T) {
	store, _ := testInstallStore(t)
	ctx := context.Background()
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	planFixtureInstall(t, store, a)
	planFixtureInstall(t, store, b)
	applyFixtureInstall(t, store, a)
	data, _, _ := fixtureArchive(t)
	if _, err := store.Apply(ctx, b, bytes.NewReader(data)); !errors.Is(err, ErrInstallConflict) {
		t.Fatalf("stale plan accepted: %v", err)
	}
	verified, _ := store.Verify(ctx)
	changed := filepath.Join(*verified.Path, "skills/sjl-fixture/SKILL.md")
	os.WriteFile(changed, []byte("user edit"), 0600)
	if _, err := store.Verify(ctx); err == nil {
		t.Fatal("edited generation verified")
	}
	if _, err := store.PlanRollback(ctx, strings.Repeat("c", 32)); err == nil {
		t.Fatal("rollback would overwrite an edit")
	}
	if data, _ := os.ReadFile(changed); string(data) != "user edit" {
		t.Fatal("edit lost")
	}
}
func TestInstallResumesAfterEachDurableBoundary(t *testing.T) {
	for _, point := range []string{"journal", "file-open", "file-write", "file", "generation", "head", "receipt"} {
		t.Run(point, func(t *testing.T) {
			store, binding := testInstallStore(t)
			id := strings.Repeat("a", 32)
			planFixtureInstall(t, store, id)
			store.afterWrite = func(at string) error {
				if at == point {
					return errors.New("simulated process interruption")
				}
				return nil
			}
			data, _, _ := fixtureArchive(t)
			if _, err := store.Apply(context.Background(), id, bytes.NewReader(data)); err == nil {
				t.Fatal("fault did not fire")
			}
			store.Close()
			reopened, err := OpenInstallStore(binding)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			receipt, err := reopened.Apply(context.Background(), id, bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if receipt.Phase != "applied" {
				t.Fatal("operation not recovered")
			}
			if _, err := reopened.Verify(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInstallRejectsReplacedNamespaceAndManifestMode(t *testing.T) {
	t.Run("namespace", func(t *testing.T) {
		store, _ := testInstallStore(t)
		if err := os.Rename(store.directory, store.directory+"-moved"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(store.directory, 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Verify(context.Background()); !errors.Is(err, ErrInstallConflict) {
			t.Fatalf("replaced namespace accepted: %v", err)
		}
	})
	t.Run("manifest mode", func(t *testing.T) {
		store, _ := testInstallStore(t)
		id := strings.Repeat("a", 32)
		planFixtureInstall(t, store, id)
		applyFixtureInstall(t, store, id)
		verified, _ := store.Verify(context.Background())
		if err := os.Chmod(filepath.Join(*verified.Path, bundleManifestName), 0755); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Verify(context.Background()); err == nil {
			t.Fatal("changed manifest mode verified")
		}
	})
}
func TestInstallScopeSymlinksAndCancellation(t *testing.T) {
	store, binding := testInstallStore(t)
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	other := binding
	other.StationKey = "codex:other"
	foreign, err := OpenInstallStore(other)
	if err != nil {
		t.Fatal(err)
	}
	defer foreign.Close()
	if _, err := foreign.Operation(context.Background(), id); err == nil {
		t.Fatal("cross-station operation visible")
	}
	if _, err := store.Operation(context.Background(), "../outside"); err == nil {
		t.Fatal("operation traversal accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Apply(ctx, id, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled apply: %v", err)
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, ".agentpod-skills")); err != nil {
		t.Fatal(err)
	}
	binding.WorkspacePath = root
	if opened, err := OpenInstallStore(binding); err == nil {
		opened.Close()
		t.Fatal("symlinked management root accepted")
	}
}
func TestConcurrentInstallHasOneWinner(t *testing.T) {
	store, binding := testInstallStore(t)
	other, err := OpenInstallStore(binding)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	a, b := strings.Repeat("a", 32), strings.Repeat("b", 32)
	planFixtureInstall(t, store, a)
	planFixtureInstall(t, store, b)
	data, _, _ := fixtureArchive(t)
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for i, s := range []*InstallStore{store, other} {
		wg.Add(1)
		go func(i int, s *InstallStore) {
			defer wg.Done()
			id := a
			if i == 1 {
				id = b
			}
			_, err := s.Apply(context.Background(), id, bytes.NewReader(data))
			results <- err
		}(i, s)
	}
	wg.Wait()
	close(results)
	wins, conflicts := 0, 0
	for err := range results {
		if err == nil {
			wins++
		} else if errors.Is(err, ErrInstallConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if wins != 1 || conflicts != 1 {
		t.Fatalf("wins %d conflicts %d", wins, conflicts)
	}
}

func TestInstallAllExporterFormatsAndIdempotentPlans(t *testing.T) {
	metadata, err := os.ReadFile("testdata/exports.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct{ File, Harness, ArchiveSHA256 string }
	if err := json.Unmarshal(metadata, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Harness, func(t *testing.T) {
			binding := InstallBinding{NodeID: "fixture-node", StationKey: fixture.Harness + ":fixture", Harness: fixture.Harness, Profile: "fixture", WorkspacePath: t.TempDir()}
			store, err := OpenInstallStore(binding)
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			data, err := os.ReadFile("testdata/" + fixture.File)
			if err != nil {
				t.Fatal(err)
			}
			id := strings.Repeat("a", 32)
			ctx := context.Background()
			first, err := store.PlanInstall(ctx, id, bytes.NewReader(data), fixture.ArchiveSHA256)
			if err != nil {
				t.Fatal(err)
			}
			repeated, err := store.PlanInstall(ctx, id, bytes.NewReader(data), fixture.ArchiveSHA256)
			if err != nil || first.PlanDigest != repeated.PlanDigest {
				t.Fatalf("plan replay changed: %v", err)
			}
			if _, err := store.Apply(ctx, id, bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			verified, err := store.Verify(ctx)
			if err != nil || verified.Current == nil || verified.Loaded.Value != nil {
				t.Fatalf("invalid verification: %v", err)
			}
		})
	}
}

func TestInstallRefusesEditedRollbackTarget(t *testing.T) {
	store, _ := testInstallStore(t)
	ctx := context.Background()
	a, b, c := strings.Repeat("a", 32), strings.Repeat("b", 32), strings.Repeat("c", 32)
	planFixtureInstall(t, store, a)
	applyFixtureInstall(t, store, a)
	old, _ := store.Verify(ctx)
	data, pin := revisedFixture(t)
	if _, err := store.PlanInstall(ctx, b, bytes.NewReader(data), pin); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, b, bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(*old.Path, "skills/sjl-fixture/SKILL.md")
	if err := os.WriteFile(file, []byte("old-generation edit"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PlanRollback(ctx, c); err == nil {
		t.Fatal("edited prior generation accepted")
	}
	actual, err := store.Verify(ctx)
	if err != nil || actual.Current.Generation != b {
		t.Fatalf("current generation changed: %v", err)
	}
}

func TestInstallUnownedNamespaceIsUntouched(t *testing.T) {
	store, binding := testInstallStore(t)
	namespace := store.directory
	store.Close()
	if err := os.RemoveAll(namespace); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(namespace, 0700); err != nil {
		t.Fatal(err)
	}
	if opened, err := OpenInstallStore(binding); err == nil {
		opened.Close()
		t.Fatal("unowned namespace adopted")
	}
	entries, err := os.ReadDir(namespace)
	if err != nil || len(entries) != 0 {
		t.Fatalf("unowned namespace changed: %v", err)
	}
}

func TestInstallRetainsCapacityForRollback(t *testing.T) {
	store, _ := testInstallStore(t)
	ctx := context.Background()
	id := strings.Repeat("a", 32)
	planFixtureInstall(t, store, id)
	applyFixtureInstall(t, store, id)
	// Unrelated retained records fill the plan quota without running hundreds of
	// redundant installations. This operation never reads their contents.
	for i := 0; i < 254; i++ {
		file := filepath.Join(store.directory, "operations", fmt.Sprintf("%032x.json", i))
		if err := os.WriteFile(file, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	data, pin, _ := fixtureArchive(t)
	if _, err := store.PlanInstall(ctx, strings.Repeat("b", 32), bytes.NewReader(data), pin); err == nil {
		t.Fatal("installation consumed the rollback reserve")
	}
	rollback := strings.Repeat("c", 32)
	if _, err := store.PlanRollback(ctx, rollback); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Apply(ctx, rollback, nil); err != nil {
		t.Fatal(err)
	}
}
