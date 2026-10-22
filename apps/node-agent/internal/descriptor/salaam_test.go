package descriptor

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// The surface was closed on purpose and is opened deliberately, one capability per PR, by the
// operator's decision on spec 2026-10-23: logs (the daemon journal) are advertised; files,
// terminal, lifecycle and writes are not, until their own PRs prove them.
func TestSalaamRequiresObservedBoundDaemonAndAdvertisesOnlyProvedCapabilities(t *testing.T) {
	base, err := os.MkdirTemp("/tmp", "sal-desc-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	base, err = filepath.EvalSymlinks(base)
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(base, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	d := NewSalaamFrom(SalaamConfig{Binary: binary, StateDir: base, Workspace: workspace})
	key := salaam.StationKey(workspace)
	if found, err := d.Detect(); err != nil || len(found) != 0 {
		t.Fatalf("missing daemon advertised: %v %v", found, err)
	}
	listener, err := net.Listen("unix", filepath.Join(base, "operator.sock"))
	if err != nil {
		t.Fatal(err)
	}
	var bound atomic.Bool
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" {
			http.NotFound(w, r)
			return
		}
		if bound.Load() {
			fmt.Fprint(w, `{"service":"healthy","agentpod_config":"/private/pins.json"}`)
		} else {
			fmt.Fprint(w, `{"service":"healthy","agentpod_config":null}`)
		}
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	if found, err := d.Detect(); err != nil || len(found) != 0 {
		t.Fatalf("unbound daemon advertised: %v %v", found, err)
	}
	bound.Store(true)
	if found, err := NewSalaamFrom(SalaamConfig{Binary: "sh", StateDir: base, Workspace: workspace}).Detect(); err != nil || len(found) != 0 {
		t.Fatal("Salaam resolved its binary through PATH")
	}
	found, err := d.Detect()
	if err != nil || len(found) != 1 {
		t.Fatalf("bound daemon missing: %v %v", found, err)
	}
	if found[0].Key != key || !reflect.DeepEqual(found[0].Capabilities, []string{"inventory", "health", "logs", "acp", "skills.inventory"}) {
		t.Fatalf("unsupported authority advertised: %+v", found[0])
	}
	if _, ok := d.(Lifecycle); ok {
		t.Fatal("lifecycle enabled")
	}
	command, cwd, _, err := d.(ACPCommander).ACPCommand(key)
	if err != nil || cwd != workspace || !reflect.DeepEqual(command, []string{binary, "acp", "--state", base}) {
		t.Fatalf("ACP target changed: %v %q %v", command, cwd, err)
	}
	if _, err := d.ListDir(key, "."); err == nil {
		t.Fatal("station filesystem enabled")
	}
	if _, _, _, err := d.ReadFile(key, "secret", 1024); err == nil {
		t.Fatal("station file read enabled")
	}
	// Logs are open since spec 2026-10-23 (decision 2): the daemon's journal, which carries no
	// session content. salaam_logs_test.go proves it reads that journal and nothing else.
	health, err := d.Health(key)
	if err != nil || !health.Running {
		t.Fatalf("healthy daemon not observed: %v %v", health, err)
	}
	_ = server.Close()
	health, err = d.Health(key)
	if err != nil || health.Running {
		t.Fatalf("stale socket reported running: %v %v", health, err)
	}
	if found, err := d.Detect(); err != nil || len(found) != 0 {
		t.Fatalf("stale socket advertised ACP: %v %v", found, err)
	}
}
