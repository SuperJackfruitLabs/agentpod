package skills

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Driven only by the explicit disposable-workspace native probe in testdata.
// Ordinary CI never starts a native harness or invokes a model.
func TestNativePlacementFixtureOperation(t *testing.T) {
	workspace := os.Getenv("SJL_NATIVE_PLACEMENT_WORKSPACE")
	if workspace == "" {
		return
	}
	marker, err := os.ReadFile(filepath.Join(workspace, ".sjl-native-fixture"))
	if err != nil || string(marker) != "synthetic native placement fixture\n" {
		t.Fatal("explicit fixture workspace required")
	}
	harness := os.Getenv("SJL_NATIVE_PLACEMENT_HARNESS")
	if _, ok := placementRoots[harness]; !ok {
		t.Fatal("unsupported fixture harness")
	}
	s, err := OpenInstallStore(InstallBinding{NodeID: "fixture-node", StationKey: harness + ":fixture", Harness: harness, Profile: "fixture", WorkspacePath: workspace})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	data, err := os.ReadFile("testdata/export-" + harness + ".tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	action := os.Getenv("SJL_NATIVE_PLACEMENT_ACTION")
	output := map[string]any{}
	switch action {
	case "install", "upgrade":
		id := strings.Repeat("a", 32)
		if action == "upgrade" {
			id = strings.Repeat("c", 32)
			artifact, err := ReadArtifact(ctx, bytes.NewReader(data), hashBytes(data), harness)
			if err != nil {
				t.Fatal(err)
			}
			revised := bytes.ReplaceAll(artifact.Files["skills/sjl-fixture/SKILL.md"], []byte("Verify a synthetic bundle."), []byte("Verify a revised synthetic bundle."))
			data = rewriteArchive(t, data, func(h *tar.Header, b []byte) (*tar.Header, []byte) {
				if h.Name == "sjl-fixture/skills/sjl-fixture/SKILL.md" {
					b = revised
				}
				if h.Name == "sjl-fixture/"+bundleManifestName {
					var m map[string]any
					decoder := json.NewDecoder(bytes.NewReader(b))
					decoder.UseNumber()
					if err := decoder.Decode(&m); err != nil {
						t.Fatal(err)
					}
					m["files"].(map[string]any)["skills/sjl-fixture/SKILL.md"].(map[string]any)["sha256"] = hashBytes(revised)
					delete(m, "digest")
					encoded, err := libraryJSON(m)
					if err != nil {
						t.Fatal(err)
					}
					m["digest"] = hashBytes(encoded)
					b, err = libraryJSON(m)
					if err != nil {
						t.Fatal(err)
					}
				}
				return h, b
			})
		}
		if _, err = s.PlanInstall(ctx, id, bytes.NewReader(data), hashBytes(data)); err != nil {
			t.Fatal(err)
		}
		if _, err = s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		output["stored"] = id
	case "plan", "activate", "replay", "publish-upgrade", "rollback", "deactivate", "restore":
		id, verb := strings.Repeat("b", 32), "activate"
		if action == "publish-upgrade" {
			id = strings.Repeat("d", 32)
		}
		if action == "rollback" {
			id = strings.Repeat("e", 32)
			verb = "rollback"
		}
		if action == "deactivate" {
			id = strings.Repeat("f", 32)
			verb = "deactivate"
		}
		if action == "restore" {
			id = strings.Repeat("1", 32)
			verb = "rollback"
		}
		p, err := s.PlanPlacement(ctx, id, verb)
		if err != nil {
			t.Fatal(err)
		}
		output["plan"] = p
		if action != "plan" {
			r, err := s.ApplyPlacement(ctx, id, p.PlanDigest)
			if err != nil {
				t.Fatal(err)
			}
			output["receipt"] = r
		}
	default:
		t.Fatal("unknown fixture operation")
	}
	verified, err := s.VerifyPlacement(ctx)
	if err != nil {
		t.Fatal(err)
	}
	output["verification"] = verified
	encoded, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println("SJL_NATIVE_RESULT " + string(encoded))
}

func TestPlacementAllExporterFixturesWithoutNativeRuntime(t *testing.T) {
	for _, harness := range []string{"codex", "opencode", "pi", "openclaw"} {
		t.Run(harness, func(t *testing.T) {
			workspace := t.TempDir()
			if err := os.Mkdir(filepath.Join(workspace, ".git"), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(workspace, ".sjl-native-fixture"), []byte("synthetic native placement fixture\n"), 0600); err != nil {
				t.Fatal(err)
			}
			t.Setenv("SJL_NATIVE_PLACEMENT_WORKSPACE", workspace)
			t.Setenv("SJL_NATIVE_PLACEMENT_HARNESS", harness)
			for _, action := range []string{"install", "plan", "activate", "replay", "upgrade", "publish-upgrade", "rollback", "deactivate", "restore"} {
				t.Setenv("SJL_NATIVE_PLACEMENT_ACTION", action)
				TestNativePlacementFixtureOperation(t)
			}
		})
	}
}
