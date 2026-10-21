package salaam

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNativeConfigurationCommandBindsArgumentsAndScrubsEnvironment(t *testing.T) {
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	node, err := filepath.EvalSymlinks("/bin/sh")
	if err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(root, "cli")
	manifest := filepath.Join(root, "host.json")
	script := `test "$1" = host || exit 1
test "$2" = config-observe || exit 2
test "$3" = --manifest || exit 3
test "$4" = '` + manifest + `' || exit 4
test "$PATH" = /usr/bin:/bin || exit 5
test -z "$SALAAM_TEST_SECRET" || exit 6
cat
`
	if err := os.WriteFile(cli, []byte(script), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifest, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SALAAM_TEST_SECRET", "must-not-transfer")
	r := &Runtime{Node: node, CLI: cli, Manifest: manifest, State: filepath.Join(root, "state"), Workspace: filepath.Join(root, "work"), NodeID: "fixture"}
	got, err := r.Configuration(context.Background(), "observe", map[string]any{"stationKey": "fixture", "settings": []string{"salaam.host.manifest"}})
	if err != nil || !strings.Contains(string(got), `"stationKey":"fixture"`) {
		t.Fatalf("native invocation: %s %v", got, err)
	}
	if _, err := r.Configuration(context.Background(), "start", nil); err == nil {
		t.Fatal("configuration invoked lifecycle verb")
	}
	if _, err := r.Configuration(context.Background(), "observe", strings.Repeat("x", 65537)); err == nil {
		t.Fatal("unbounded request accepted")
	}
	if err := os.Chmod(cli, 0666); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Configuration(context.Background(), "observe", nil); err == nil {
		t.Fatal("unreviewed public executable accepted")
	}
}
