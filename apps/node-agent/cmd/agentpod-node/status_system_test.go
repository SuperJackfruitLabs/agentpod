package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// Observed on a real Linux host after a system-wide (sudo) install: plain
// `apn status` printed "installed: no / running: no / not enrolled" because it
// only looked at the user scope. These tests pin the truthful output.

var (
	sysRunning = service.Status{Installed: true, Enabled: true, Running: true, PID: 4242, UnitPath: "/etc/systemd/system/agentpod-node.service"}
	userAbsent = service.Status{UnitPath: "/home/u/.config/systemd/user/agentpod-node.service"}
	userRun    = service.Status{Installed: true, Enabled: true, Running: true, PID: 99, UnitPath: "/home/u/.config/systemd/user/agentpod-node.service"}
)

func noCred(t *testing.T) func(string, string, string) (bool, error) {
	return func(string, string, string) (bool, error) {
		t.Fatal("checkCred must not be called without a readable config")
		return false, nil
	}
}

func TestStatus_SystemInstallUnprivileged(t *testing.T) {
	var buf bytes.Buffer
	code := statusCmdScoped(&fakeManager{status: userAbsent}, &fakeManager{status: sysRunning},
		config.Config{}, errors.New("no such file"), noCred(t), false, &buf)
	out := buf.String()
	for _, want := range []string{
		"Service (system-wide):",
		"yes (/etc/systemd/system/agentpod-node.service)",
		"yes (pid 4242)",
		"sudo apn status",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	for _, bad := range []string{"installed:  no", "not enrolled", "Service (user):"} {
		if strings.Contains(out, bad) {
			t.Errorf("must not print %q (the observed lie) in:\n%s", bad, out)
		}
	}
	if code != 0 {
		t.Errorf("running system service: exit %d want 0", code)
	}
}

func TestStatus_SystemInstallJSON(t *testing.T) {
	var buf bytes.Buffer
	statusCmdScoped(&fakeManager{status: userAbsent}, &fakeManager{status: sysRunning},
		config.Config{}, errors.New("no such file"), noCred(t), true, &buf)
	var got struct {
		Service       service.Status
		SystemService *service.Status
		Hub           struct{ Note string }
	}
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("json: %v\n%s", err, buf.String())
	}
	if got.SystemService == nil || !got.SystemService.Running {
		t.Errorf("SystemService missing/not running: %s", buf.String())
	}
	if !strings.Contains(got.Hub.Note, "sudo") {
		t.Errorf("hub note should mention sudo: %q", got.Hub.Note)
	}
}

func TestStatus_BothInstalls(t *testing.T) {
	cfg := config.Config{Hub: "https://hub.example", NodeID: "node_u", NodeSecret: "s"}
	var buf bytes.Buffer
	statusCmdScoped(&fakeManager{status: userRun}, &fakeManager{status: sysRunning},
		cfg, nil, func(string, string, string) (bool, error) { return true, nil }, false, &buf)
	out := buf.String()
	for _, want := range []string{"Service (user):", "yes (pid 99)", "node_u", "Service (system-wide):", "yes (pid 4242)", "sudo apn status", "both"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestStatus_UserOnlyUnchanged(t *testing.T) {
	var buf bytes.Buffer
	statusCmdScoped(&fakeManager{status: userRun}, &fakeManager{status: service.Status{UnitPath: "/etc/systemd/system/agentpod-node.service"}},
		config.Config{}, errors.New("x"), noCred(t), false, &buf)
	out := buf.String()
	if !strings.HasPrefix(out, "Service:\n") || strings.Contains(out, "system-wide") {
		t.Errorf("user-only output changed:\n%s", out)
	}
}

func TestStatus_SystemProbeErrorIgnored(t *testing.T) {
	var buf bytes.Buffer
	statusCmdScoped(&fakeManager{status: userRun}, &fakeManager{statusErr: errors.New("boom")},
		config.Config{}, errors.New("x"), noCred(t), false, &buf)
	if strings.Contains(buf.String(), "error") {
		t.Errorf("a failed system-scope probe must not break user status:\n%s", buf.String())
	}
}

func TestLogs_SystemInstallUnprivileged(t *testing.T) {
	var errBuf bytes.Buffer
	got := resolveLogsUnit("linux", &fakeManager{status: userAbsent}, &fakeManager{status: sysRunning}, &errBuf)
	if got != sysRunning.UnitPath {
		t.Errorf("unit: got %q want system unit", got)
	}
	if !strings.Contains(errBuf.String(), "sudo journalctl -u agentpod-node") {
		t.Errorf("missing sudo hint on stderr: %q", errBuf.String())
	}
}
