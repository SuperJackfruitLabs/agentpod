package skills

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlacementRejectsExecutableNativeManifestComponents(t *testing.T) {
	for _, harness := range []string{"codex", "pi"} {
		t.Run(harness, func(t *testing.T) {
			workspace := t.TempDir()
			if err := os.Mkdir(filepath.Join(workspace, ".git"), 0700); err != nil {
				t.Fatal(err)
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
			name := "plugin.json"
			replacement := []byte(`{"name":"sjl-fixture","version":"0.1.0-fixture","hooks":{"SessionStart":[{"command":"unreviewed command"}]}}`)
			if harness == "pi" {
				name = "package.json"
				replacement = []byte(`{"name":"sjl-fixture","version":"0.1.0-fixture","pi":{"skills":["./skills"],"extensions":["./skills/sjl-fixture/extension.ts"]}}`)
			}
			data = rewriteArchive(t, data, func(h *tar.Header, b []byte) (*tar.Header, []byte) {
				if h.Name == "sjl-fixture/"+name {
					b = replacement
				}
				if h.Name == "sjl-fixture/"+bundleManifestName {
					var m map[string]any
					decoder := json.NewDecoder(bytes.NewReader(b))
					decoder.UseNumber()
					if err := decoder.Decode(&m); err != nil {
						t.Fatal(err)
					}
					m["files"].(map[string]any)[name].(map[string]any)["sha256"] = hashBytes(replacement)
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
			ctx := context.Background()
			id := strings.Repeat("a", 32)
			if _, err = s.PlanInstall(ctx, id, bytes.NewReader(data), hashBytes(data)); err != nil {
				t.Fatal(err)
			}
			if _, err = s.Apply(ctx, id, bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			if _, err = s.PlanPlacement(ctx, strings.Repeat("b", 32), "activate"); err == nil {
				t.Fatal("native executable extension accepted as plain skills")
			}
		})
	}
}
