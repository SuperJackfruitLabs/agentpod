package salaam

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestReviewedRuntimeRejectsUnpinnedPathsAndForeignStartupReceipt(t *testing.T) {
	root := t.TempDir()
	root, _ = filepath.EvalSymlinks(root)
	node, _ := os.Executable()
	node, _ = filepath.EvalSymlinks(node)
	cli := filepath.Join(root, "salaam.mjs")
	manifest := filepath.Join(root, "host.json")
	for _, p := range []string{cli, manifest} {
		if err := os.WriteFile(p, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	r := &Runtime{Node: node, CLI: cli, Manifest: manifest, State: filepath.Join(root, "state"), Workspace: filepath.Join(root, "workspace"), NodeID: "node_fixture"}
	calls := 0
	var strict any
	r.run = func(ctx context.Context, exe string, args []string) ([]byte, error) {
		calls++
		if exe != node || !reflect.DeepEqual(args, []string{cli, "host", "start", "--manifest", manifest}) {
			t.Fatalf("unreviewed command: %q %q", exe, args)
		}
		return json.Marshal(map[string]any{"version": 1, "ready": true, "node": node, "cli": cli, "state": r.State, "workspace": r.Workspace, "node_id": r.NodeID, "manifest_digest": strings.Repeat("a", 64), "pins_digest": strings.Repeat("b", 64), "strict_work": strict})
	}
	if err := r.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}

	if err := r.ensureStrict(context.Background()); err == nil {
		t.Fatal("disabled host admitted strict work")
	}
	for _, v := range []any{map[string]any{"version": 2}, map[string]any{"version": 1, "extra": true}, true} {
		strict = v
		if err := r.Ensure(context.Background()); err == nil {
			t.Fatal("unknown strict work startup receipt accepted")
		}
	}
	strict = map[string]any{"version": 1}
	if err := r.ensureStrict(context.Background()); err != nil {
		t.Fatal(err)
	}
	strict = nil
	calls = 1 // Below checks concern whether invalid paths launch anything.
	r.Node = "node"
	if err := r.Ensure(context.Background()); err == nil || calls != 1 {
		t.Fatal("PATH runtime accepted")
	}
	r.Node = node
	r.run = func(context.Context, string, []string) ([]byte, error) {
		return []byte(`{"version":1,"ready":true,"node_id":"foreign"}`), nil
	}
	if err := r.Ensure(context.Background()); err == nil {
		t.Fatal("foreign startup receipt accepted")
	}
}
