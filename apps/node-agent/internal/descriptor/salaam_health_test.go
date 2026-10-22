package descriptor

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/salaam"
)

// fakeSalaamDaemon serves /v1/health on <state>/operator.sock with the given extra JSON fields.
func fakeSalaamDaemon(t *testing.T, extra string) (state, workspace string) {
	t.Helper()
	base, err := os.MkdirTemp("/tmp", "sal-health-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	base, _ = filepath.EvalSymlinks(base)
	state, workspace = filepath.Join(base, "state"), filepath.Join(base, "workspace")
	for _, d := range []string{state, workspace} {
		if err := os.Mkdir(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	l, err := net.Listen("unix", filepath.Join(state, "operator.sock"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"service":"healthy","agentpod_config":"/p.json","pid":%d%s}`, os.Getpid(), extra)
	})}
	go func() { _ = srv.Serve(l) }()
	t.Cleanup(func() { _ = srv.Close() })
	return state, workspace
}

func salaamHealthOf(t *testing.T, state, workspace string) Health {
	t.Helper()
	bin, _ := os.Executable()
	d := NewSalaamFrom(SalaamConfig{Binary: bin, StateDir: state, Workspace: workspace})
	h, err := d.Health(salaam.StationKey(workspace))
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestSalaamHealthFillsProcessMetricsDiskAndReportedActivity(t *testing.T) {
	disk := int64(4096)
	var askedFor string
	orig := salaamWorkspaceDisk
	salaamWorkspaceDisk = func(dir string) *int64 { askedFor = dir; return &disk }
	t.Cleanup(func() { salaamWorkspaceDisk = orig })

	state, workspace := fakeSalaamDaemon(t, `,"last_activity_at":"2026-10-23T04:05:06.789+05:30"`)
	h := salaamHealthOf(t, state, workspace)
	if !h.Running || h.PID == nil || *h.PID != os.Getpid() {
		t.Fatalf("daemon not observed: %+v", h)
	}
	if h.CpuPct == nil || h.MemBytes == nil || h.UptimeSec == nil {
		t.Fatalf("process metrics missing for the daemon pid: %+v", h)
	}
	if h.DiskBytes == nil || *h.DiskBytes != disk || askedFor != workspace {
		t.Fatalf("disk not measured on the workspace: %v asked=%q", h.DiskBytes, askedFor)
	}
	if h.LastActivity == nil || *h.LastActivity != "2026-10-22T22:35:06Z" {
		t.Fatalf("daemon's last_activity_at not used: %v", h.LastActivity)
	}
}

func TestSalaamHealthFallsBackToNewestStateMtime(t *testing.T) {
	for _, extra := range []string{``, `,"last_activity_at":"yesterday"`} {
		state, workspace := fakeSalaamDaemon(t, extra)
		when := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
		f := filepath.Join(state, "sessions", "s1.json")
		_ = os.MkdirAll(filepath.Dir(f), 0o700)
		if err := os.WriteFile(f, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(f, when, when); err != nil {
			t.Fatal(err)
		}
		// The operator socket lives in the state directory too: age it so the session file wins.
		old := when.Add(-time.Hour)
		_ = os.Chtimes(filepath.Join(state, "operator.sock"), old, old)
		h := salaamHealthOf(t, state, workspace)
		if h.LastActivity == nil || *h.LastActivity != "2026-10-01T12:00:00Z" {
			t.Fatalf("extra=%q: newest state mtime not used: %v", extra, h.LastActivity)
		}
	}
}

func TestMountUsedBytesOnlyForAMountRoot(t *testing.T) {
	if _, ok := mountUsedBytes(t.TempDir()); ok {
		t.Fatal("a plain directory was measured as a whole filesystem")
	}
	if runtime.GOOS != "linux" {
		t.Skip("needs a known mount point")
	}
	if _, ok := mountUsedBytes("/proc"); !ok {
		t.Fatal("/proc is its own mount and was not measured")
	}
}
