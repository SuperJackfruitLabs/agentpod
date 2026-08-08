package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// fakeManager is a scripted service.Manager for testing service_cmds.go's
// CLI-layer logic without ever touching launchctl/systemctl.
type fakeManager struct {
	status    service.Status
	statusErr error

	installErr, uninstallErr, startErr, stopErr, restartErr error

	installCalled, uninstallCalled, startCalled, stopCalled, restartCalled bool
}

func (f *fakeManager) Install() error   { f.installCalled = true; return f.installErr }
func (f *fakeManager) Uninstall() error { f.uninstallCalled = true; return f.uninstallErr }
func (f *fakeManager) Start() error     { f.startCalled = true; return f.startErr }
func (f *fakeManager) Stop() error      { f.stopCalled = true; return f.stopErr }
func (f *fakeManager) Restart() error   { f.restartCalled = true; return f.restartErr }
func (f *fakeManager) Status() (service.Status, error) {
	return f.status, f.statusErr
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

func TestStatusCmd(t *testing.T) {
	cfg := config.Config{Hub: "https://hub.agentpod.dev", NodeID: "node_161e685104dc488ebd11", NodeSecret: "s3cr3t"}
	running := service.Status{Installed: true, Enabled: true, Running: true, PID: 35547, UnitPath: "/tmp/dev.agentpod.node.plist"}
	stopped := service.Status{Installed: true, Enabled: true, Running: false, UnitPath: "/tmp/dev.agentpod.node.plist"}

	t.Run("running_and_credential_valid_exit_0", func(t *testing.T) {
		mgr := &fakeManager{status: running}
		checkCred := func(hub, id, secret string) (bool, error) { return true, nil }
		var buf bytes.Buffer
		code := statusCmd(mgr, cfg, nil, checkCred, false, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		out := buf.String()
		if !strings.Contains(out, "running:    yes (pid 35547)") {
			t.Errorf("missing running line, got:\n%s", out)
		}
		if !strings.Contains(out, "credential: valid") {
			t.Errorf("missing valid-credential line, got:\n%s", out)
		}
	})

	t.Run("running_and_credential_rejected_exit_1", func(t *testing.T) {
		mgr := &fakeManager{status: running}
		checkCred := func(hub, id, secret string) (bool, error) { return false, nil }
		var buf bytes.Buffer
		code := statusCmd(mgr, cfg, nil, checkCred, false, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
		if !strings.Contains(buf.String(), "credential: INVALID") {
			t.Errorf("missing INVALID credential line, got:\n%s", buf.String())
		}
	})

	t.Run("hub_unreachable_exit_1", func(t *testing.T) {
		mgr := &fakeManager{status: running}
		checkCred := func(hub, id, secret string) (bool, error) { return false, errors.New("dial tcp: connection refused") }
		var buf bytes.Buffer
		code := statusCmd(mgr, cfg, nil, checkCred, false, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
		out := buf.String()
		if !strings.Contains(out, "reachable:  no") {
			t.Errorf("missing reachable:no line, got:\n%s", out)
		}
		if !strings.Contains(out, "credential: unknown") {
			t.Errorf("missing unknown-credential line, got:\n%s", out)
		}
	})

	t.Run("not_running_exit_1", func(t *testing.T) {
		mgr := &fakeManager{status: stopped}
		checkCred := func(hub, id, secret string) (bool, error) { return true, nil }
		var buf bytes.Buffer
		code := statusCmd(mgr, cfg, nil, checkCred, false, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
		if !strings.Contains(buf.String(), "running:    no") {
			t.Errorf("missing running:no line, got:\n%s", buf.String())
		}
	})

	t.Run("no_config_not_enrolled_exit_1", func(t *testing.T) {
		mgr := &fakeManager{status: stopped}
		checkCred := func(hub, id, secret string) (bool, error) {
			t.Fatal("checkCred must not be called when there is no config")
			return false, nil
		}
		var buf bytes.Buffer
		code := statusCmd(mgr, config.Config{}, errors.New("open config.json: no such file or directory"), checkCred, false, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
		if !strings.Contains(buf.String(), "not enrolled") {
			t.Errorf("missing not-enrolled hint, got:\n%s", buf.String())
		}
	})

	t.Run("json_output_unmarshals_into_expected_shape", func(t *testing.T) {
		mgr := &fakeManager{status: running}
		checkCred := func(hub, id, secret string) (bool, error) { return true, nil }
		var buf bytes.Buffer
		code := statusCmd(mgr, cfg, nil, checkCred, true, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}

		var got struct {
			Service service.Status
			Hub     struct {
				URL             string
				NodeID          string
				Reachable       bool
				CredentialValid bool
			}
		}
		if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
			t.Fatalf("unmarshal: %v\noutput:\n%s", err, buf.String())
		}
		if got.Service.PID != 35547 {
			t.Errorf("Service.PID: got %d want 35547", got.Service.PID)
		}
		if !got.Service.Running {
			t.Error("Service.Running: got false want true")
		}
		if got.Hub.URL != cfg.Hub {
			t.Errorf("Hub.URL: got %q want %q", got.Hub.URL, cfg.Hub)
		}
		if got.Hub.NodeID != cfg.NodeID {
			t.Errorf("Hub.NodeID: got %q want %q", got.Hub.NodeID, cfg.NodeID)
		}
		if !got.Hub.Reachable {
			t.Error("Hub.Reachable: got false want true")
		}
		if !got.Hub.CredentialValid {
			t.Error("Hub.CredentialValid: got false want true")
		}
	})
}

// ---------------------------------------------------------------------------
// stop / start / restart
// ---------------------------------------------------------------------------

func TestStopCmd(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mgr := &fakeManager{}
		var buf bytes.Buffer
		code := stopCmd(mgr, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		if !mgr.stopCalled {
			t.Error("Stop() was not called")
		}
		if !strings.Contains(buf.String(), "stopped and disabled") || !strings.Contains(buf.String(), "'apn start' re-enables") {
			t.Errorf("missing undo hint, got:\n%s", buf.String())
		}
	})

	t.Run("manager_error_maps_to_exit_1", func(t *testing.T) {
		mgr := &fakeManager{stopErr: errors.New("disable failed")}
		var buf bytes.Buffer
		code := stopCmd(mgr, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
	})
}

func TestStartCmd(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mgr := &fakeManager{}
		var buf bytes.Buffer
		code := startCmd(mgr, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		if !mgr.startCalled {
			t.Error("Start() was not called")
		}
	})

	t.Run("manager_error_prints_install_hint_and_exits_1", func(t *testing.T) {
		mgr := &fakeManager{startErr: errors.New("no such job")}
		var buf bytes.Buffer
		code := startCmd(mgr, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
		if !strings.Contains(buf.String(), "apn service install") {
			t.Errorf("missing install hint, got:\n%s", buf.String())
		}
	})
}

func TestRestartCmd(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		mgr := &fakeManager{}
		var buf bytes.Buffer
		code := restartCmd(mgr, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		if !mgr.restartCalled {
			t.Error("Restart() was not called")
		}
	})

	t.Run("manager_error_maps_to_exit_1", func(t *testing.T) {
		mgr := &fakeManager{restartErr: errors.New("boom")}
		var buf bytes.Buffer
		code := restartCmd(mgr, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
	})
}

// ---------------------------------------------------------------------------
// service install / uninstall
// ---------------------------------------------------------------------------

func TestRunServiceVerbInstall(t *testing.T) {
	t.Run("success_prints_platform_summary", func(t *testing.T) {
		mgr := &fakeManager{status: service.Status{UnitPath: "/Users/x/Library/LaunchAgents/dev.agentpod.node.plist"}}
		var buf bytes.Buffer
		code := runServiceVerb("install", nil, mgr, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		if !mgr.installCalled {
			t.Error("Install() was not called")
		}
	})

	t.Run("manager_error_maps_to_exit_1", func(t *testing.T) {
		mgr := &fakeManager{installErr: errors.New("bootstrap failed")}
		var buf bytes.Buffer
		code := runServiceVerb("install", nil, mgr, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
	})
}

func TestRunServiceVerbUninstall(t *testing.T) {
	t.Run("success_prints_confirmation", func(t *testing.T) {
		mgr := &fakeManager{}
		var buf bytes.Buffer
		code := runServiceVerb("uninstall", nil, mgr, &buf)
		if code != 0 {
			t.Errorf("exit code: got %d want 0", code)
		}
		if !mgr.uninstallCalled {
			t.Error("Uninstall() was not called")
		}
		if !strings.Contains(buf.String(), "removed") {
			t.Errorf("missing removal confirmation, got:\n%s", buf.String())
		}
	})

	t.Run("manager_error_maps_to_exit_1", func(t *testing.T) {
		mgr := &fakeManager{uninstallErr: errors.New("boom")}
		var buf bytes.Buffer
		code := runServiceVerb("uninstall", nil, mgr, &buf)
		if code != 1 {
			t.Errorf("exit code: got %d want 1", code)
		}
	})
}

func TestRunServiceVerbUnknown(t *testing.T) {
	mgr := &fakeManager{}
	var buf bytes.Buffer
	code := runServiceVerb("bogus", nil, mgr, &buf)
	if code != 2 {
		t.Errorf("exit code: got %d want 2", code)
	}
}

func TestPrintServiceSummary(t *testing.T) {
	t.Run("darwin", func(t *testing.T) {
		var buf bytes.Buffer
		printServiceSummary("darwin", "/Users/x/Library/LaunchAgents/dev.agentpod.node.plist", &buf)
		out := buf.String()
		for _, want := range []string{"apn status", "apn logs -f", "apn restart", "apn service uninstall", "LaunchAgent"} {
			if !strings.Contains(out, want) {
				t.Errorf("missing %q in:\n%s", want, out)
			}
		}
	})

	t.Run("linux_user_scope", func(t *testing.T) {
		var buf bytes.Buffer
		printServiceSummary("linux", "/home/x/.config/systemd/user/agentpod-node.service", &buf)
		out := buf.String()
		if !strings.Contains(out, "systemd --user") {
			t.Errorf("missing user-scope label, got:\n%s", out)
		}
		if !strings.Contains(out, "loginctl enable-linger") {
			t.Errorf("missing linger hint, got:\n%s", out)
		}
	})

	t.Run("linux_system_scope", func(t *testing.T) {
		var buf bytes.Buffer
		printServiceSummary("linux", "/etc/systemd/system/agentpod-node.service", &buf)
		out := buf.String()
		if !strings.Contains(out, "system-wide") {
			t.Errorf("missing system-scope label, got:\n%s", out)
		}
		if strings.Contains(out, "loginctl") {
			t.Errorf("system scope should not print the linger hint, got:\n%s", out)
		}
	})
}

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

func TestBuildLogsCmd(t *testing.T) {
	t.Run("darwin_default", func(t *testing.T) {
		cmd := buildLogsCmd("darwin", "/Users/x", "", logsOptions{Lines: 50})
		want := []string{"tail", "-n", "50", filepath.Join("/Users/x", "Library", "Logs", "agentpod-node.log")}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Errorf("argv: got %v want %v", cmd.Args, want)
		}
	})

	t.Run("darwin_follow", func(t *testing.T) {
		cmd := buildLogsCmd("darwin", "/Users/x", "", logsOptions{Lines: 20, Follow: true})
		want := []string{"tail", "-n", "20", "-f", filepath.Join("/Users/x", "Library", "Logs", "agentpod-node.log")}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Errorf("argv: got %v want %v", cmd.Args, want)
		}
	})

	t.Run("linux_user_scope_follow", func(t *testing.T) {
		cmd := buildLogsCmd("linux", "/home/x", "/home/x/.config/systemd/user/agentpod-node.service", logsOptions{Lines: 50, Follow: true})
		want := []string{"journalctl", "-f", "-n", "50", "--user-unit", "agentpod-node"}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Errorf("argv: got %v want %v", cmd.Args, want)
		}
	})

	t.Run("linux_system_scope", func(t *testing.T) {
		cmd := buildLogsCmd("linux", "/home/x", "/etc/systemd/system/agentpod-node.service", logsOptions{Lines: 100})
		want := []string{"journalctl", "-n", "100", "-u", "agentpod-node"}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Errorf("argv: got %v want %v", cmd.Args, want)
		}
	})
}

func TestResolveLogsCmd(t *testing.T) {
	t.Run("darwin_missing_log_file_friendly_error", func(t *testing.T) {
		statFail := func(string) error { return os.ErrNotExist }
		_, err := resolveLogsCmd("darwin", "/Users/x", "", logsOptions{Lines: 50}, statFail)
		if err == nil {
			t.Fatal("expected a friendly error for a missing log file")
		}
	})

	t.Run("darwin_log_file_present", func(t *testing.T) {
		statOK := func(string) error { return nil }
		cmd, err := resolveLogsCmd("darwin", "/Users/x", "", logsOptions{Lines: 50}, statOK)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cmd.Args[0] != "tail" {
			t.Errorf("expected tail, got %v", cmd.Args)
		}
	})

	t.Run("linux_never_stats_a_log_file", func(t *testing.T) {
		called := false
		stat := func(string) error { called = true; return nil }
		cmd, err := resolveLogsCmd("linux", "/home/x", "/etc/systemd/system/agentpod-node.service", logsOptions{Lines: 50}, stat)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if cmd.Args[0] != "journalctl" {
			t.Errorf("expected journalctl, got %v", cmd.Args)
		}
		if called {
			t.Error("linux path should never call stat")
		}
	})
}
