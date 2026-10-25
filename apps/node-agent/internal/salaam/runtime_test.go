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

func TestLauncherProfileStartsOnlyTheProvisionedUnitForThisStation(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	node, _ := os.Executable()
	node, _ = filepath.EvalSymlinks(node)
	cli := filepath.Join(root, "salaam.mjs")
	workspace := filepath.Join(root, "workspace")
	key := StationKey(workspace)[len("salaam:"):]
	old := launcherRoot
	launcherRoot = filepath.Join(root, "stations")
	t.Cleanup(func() { launcherRoot = old })
	own := filepath.Join(launcherRoot, key, "host.json")
	other := filepath.Join(launcherRoot, strings.Repeat("0", 16), "host.json")
	for _, p := range []string{cli, own, other} {
		_ = os.MkdirAll(filepath.Dir(p), 0755)
		if err := os.WriteFile(p, []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	state := filepath.Join(root, "state")
	var got []string
	r := &Runtime{Node: node, CLI: cli, Manifest: own, State: state, Workspace: workspace, NodeID: "node_fixture"}
	r.run = func(ctx context.Context, exe string, args []string) ([]byte, error) {
		got = args
		return json.Marshal(map[string]any{"version": 1, "ready": true, "node": node, "cli": cli, "state": state, "workspace": workspace, "node_id": "node_fixture", "manifest_digest": strings.Repeat("a", 64), "pins_digest": strings.Repeat("b", 64), "strict_work": map[string]any{"version": 1}})
	}
	if err := r.ensureStrict(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{cli, "host", "unit-start", "--unit", "salaam-host@" + key + ".service", "--state", state}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launcher command %q, want %q", got, want)
	}
	// Another station's manifest, or one outside the launcher root, keeps node-owned startup.
	for _, m := range []string{other, cli} {
		r.Manifest = m
		if err := r.Ensure(context.Background()); err != nil {
			t.Fatal(err)
		}
		if got[1] != "host" || got[2] != "start" || got[4] != m {
			t.Fatalf("manifest %s started via %q", m, got)
		}
	}
}

func TestPassiveHealthNeverStartsConfiguredRuntime(t *testing.T) {
	calls := 0
	r := &Runtime{run: func(context.Context, string, []string) ([]byte, error) { calls++; return nil, nil }}
	c := &Client{Runtime: r, State: t.TempDir()}
	healthy, pid := c.PassiveHealth(context.Background())
	if healthy || pid != nil || calls != 0 {
		t.Fatalf("passive health started runtime: healthy=%v pid=%v calls=%d", healthy, pid, calls)
	}
}

// A second, separately provisioned launcher (its own root and unit prefix) is used only when the
// node is configured for it; the defaults keep the salaam-host@ unit under /etc/salaam/stations.
func TestConfiguredLauncherRootAndPrefixNameTheirOwnUnit(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	node, _ := os.Executable()
	node, _ = filepath.EvalSymlinks(node)
	cli := filepath.Join(root, "salaam.mjs")
	workspace := filepath.Join(root, "workspace")
	key := StationKey(workspace)[len("salaam:"):]
	devRoot := filepath.Join(root, "dev-stations")
	own := filepath.Join(devRoot, key, "host.json")
	for _, p := range []string{cli, own} {
		_ = os.MkdirAll(filepath.Dir(p), 0755)
		_ = os.WriteFile(p, []byte("fixture"), 0600)
	}
	state := filepath.Join(root, "state")
	var got []string
	r := &Runtime{Node: node, CLI: cli, Manifest: own, State: state, Workspace: workspace, NodeID: "node_fixture", LauncherRoot: devRoot, UnitPrefix: "salaam-dev-host"}
	r.run = func(ctx context.Context, exe string, args []string) ([]byte, error) {
		got = args
		return json.Marshal(map[string]any{"version": 1, "ready": true, "node": node, "cli": cli, "state": state, "workspace": workspace, "node_id": "node_fixture", "manifest_digest": strings.Repeat("a", 64), "pins_digest": strings.Repeat("b", 64), "strict_work": map[string]any{"version": 1}})
	}
	if err := r.ensureStrict(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{cli, "host", "unit-start", "--unit", "salaam-dev-host@" + key + ".service", "--state", state}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("launcher command %q, want %q", got, want)
	}
	// The same manifest without the configured root is not a launcher manifest.
	r.LauncherRoot, r.UnitPrefix = "", ""
	if err := r.Ensure(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got[2] != "start" {
		t.Fatalf("an unconfigured root still used the launcher: %q", got)
	}
	// A prefix that is not salaam-<word>-host never names a unit.
	for _, bad := range []string{"other-host", "salaam-host-x", "salaam-a-b-host", "Salaam-host"} {
		r.LauncherRoot, r.UnitPrefix = devRoot, bad
		if u := r.launcherUnit(); u != "" {
			t.Fatalf("prefix %q named unit %q", bad, u)
		}
	}
}
