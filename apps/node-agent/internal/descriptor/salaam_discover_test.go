package descriptor

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func salaamHome(t *testing.T) string {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "sal-home-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	home, _ = filepath.EvalSymlinks(home)
	for _, d := range []string{".local/bin", ".local/state/salaam", ".config/salaam", "work", "elsewhere"} {
		if err := os.MkdirAll(filepath.Join(home, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".local/bin/salaam"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return home
}

var notOnPath = func(string) (string, error) { return "", errors.New("absent") }

func TestDiscoverSalaamDerivesAPerUserInstall(t *testing.T) {
	home := salaamHome(t)
	if got := DiscoverSalaam(SalaamConfig{}, home, notOnPath); got.StateDir != "" {
		t.Fatalf("state without an operator socket was adopted: %+v", got)
	}
	ln, err := net.Listen("unix", filepath.Join(home, ".local/state/salaam/operator.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	got := DiscoverSalaam(SalaamConfig{NodeID: "n"}, home, notOnPath)
	want := SalaamConfig{Binary: filepath.Join(home, ".local/bin/salaam"), StateDir: filepath.Join(home, ".local/state/salaam"), Workspace: filepath.Join(home, "work"), NodeID: "n"}
	if got != want {
		t.Fatalf("discovery = %+v, want %+v", got, want)
	}
	pins := fmt.Sprintf(`{"version":1,"workspace":%q}`, filepath.Join(home, "elsewhere"))
	if err := os.WriteFile(filepath.Join(home, ".config/salaam/agentpod-pins.json"), []byte(pins), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := DiscoverSalaam(SalaamConfig{}, home, notOnPath); got.Workspace != filepath.Join(home, "elsewhere") {
		t.Fatalf("workspace ignored Salaam's pins: %q", got.Workspace)
	}
	if got := DiscoverSalaam(SalaamConfig{}, home, func(string) (string, error) { return "/opt/bin/salaam", nil }); got.Binary != "/opt/bin/salaam" {
		t.Fatalf("PATH salaam not preferred: %q", got.Binary)
	}
	explicit := SalaamConfig{Binary: "/x/salaam", StateDir: "/x/state", Workspace: "/x/work"}
	if got := DiscoverSalaam(explicit, home, notOnPath); got != explicit {
		t.Fatalf("explicit config overridden: %+v", got)
	}
}

func TestDiscoverSalaamLeavesAHostWithoutSalaamUnconfigured(t *testing.T) {
	home := salaamHome(t)
	_ = os.Remove(filepath.Join(home, ".local/bin/salaam"))
	if got := DiscoverSalaam(SalaamConfig{}, home, notOnPath); got != (SalaamConfig{}) {
		t.Fatalf("Salaam invented on a host without it: %+v", got)
	}
}

func TestSalaamLogsWhyAConfiguredDaemonIsNotDetected(t *testing.T) {
	home := salaamHome(t)
	state := filepath.Join(home, ".local/state/salaam")
	ln, err := net.Listen("unix", filepath.Join(state, "operator.sock"))
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"service":"healthy","agentpod_config":null}`)
	})}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Shutdown(context.Background())
	var logged []string
	d := NewSalaamFrom(SalaamConfig{Binary: filepath.Join(home, ".local/bin/salaam"), StateDir: state, Workspace: filepath.Join(home, "work")}).(*salaamDescriptor)
	d.logf = func(f string, a ...any) { logged = append(logged, fmt.Sprintf(f, a...)) }
	for i := 0; i < 2; i++ {
		if found, _ := d.Detect(); len(found) != 0 {
			t.Fatal("unbound daemon detected")
		}
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "not bound to AgentPod") {
		t.Fatalf("missed detection not logged once with its reason: %q", logged)
	}
}
