package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scriptResult is a scripted reply for one exact argv, keyed by the joined
// command in recordingRunner.script.
type scriptResult struct {
	out string
	err error
}

// recordingRunner is the table-test seam: it records every argv it is
// called with (in order) and returns a scripted result keyed by the exact
// argv, defaulting to ("", nil) for anything unscripted.
type recordingRunner struct {
	calls  [][]string
	script map[string]scriptResult
}

func newRecordingRunner() *recordingRunner {
	return &recordingRunner{script: map[string]scriptResult{}}
}

func (r *recordingRunner) run(name string, args ...string) (string, error) {
	call := append([]string{name}, args...)
	r.calls = append(r.calls, call)
	if res, ok := r.script[strings.Join(call, " ")]; ok {
		return res.out, res.err
	}
	return "", nil
}

func (r *recordingRunner) on(argv []string, out string, err error) {
	r.script[strings.Join(argv, " ")] = scriptResult{out: out, err: err}
}

func assertCalls(t *testing.T, got [][]string, want [][]string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("call count: got %d %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if !equalArgv(got[i], want[i]) {
			t.Errorf("call[%d]: got %v want %v", i, got[i], want[i])
		}
	}
}

func equalArgv(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// newTestManager builds a launchdManager over a temp home and a fake binary
// path, so tests never touch the real ~/Library or invoke launchctl.
func newTestManager(t *testing.T, run *recordingRunner) (*launchdManager, string) {
	t.Helper()
	home := t.TempDir()
	fakeBin := filepath.Join(t.TempDir(), "agentpod-node")
	m := &launchdManager{
		home: home,
		uid:  os.Getuid(),
		run:  run.run,
		binPath: func() (string, error) {
			return fakeBin, nil
		},
	}
	return m, fakeBin
}

func target(uid int) string {
	return fmt.Sprintf("gui/%d/dev.agentpod.node", uid)
}

func domain(uid int) string {
	return fmt.Sprintf("gui/%d", uid)
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

func TestLaunchdStop(t *testing.T) {
	t.Run("bootout_error_ignored_disable_error_returned", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "bootout", target(m.uid)}, "", fmt.Errorf("no such process"))
		run.on([]string{"launchctl", "disable", target(m.uid)}, "", fmt.Errorf("disable failed"))

		err := m.Stop()
		if err == nil {
			t.Fatal("expected error from disable failure")
		}
		want := [][]string{
			{"launchctl", "bootout", target(m.uid)},
			{"launchctl", "disable", target(m.uid)},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("bootout_error_ignored_disable_succeeds", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "bootout", target(m.uid)}, "", fmt.Errorf("no such process"))

		if err := m.Stop(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := [][]string{
			{"launchctl", "bootout", target(m.uid)},
			{"launchctl", "disable", target(m.uid)},
		}
		assertCalls(t, run.calls, want)
	})
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

func TestLaunchdStart(t *testing.T) {
	t.Run("bootstrap_succeeds_no_fallback", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		if err := m.Install(); err != nil {
			t.Fatalf("Install setup: %v", err)
		}
		run.calls = nil // reset: we only care about Start()'s own argv

		if err := m.Start(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := [][]string{
			{"launchctl", "enable", target(m.uid)},
			{"launchctl", "bootstrap", domain(m.uid), m.plistPath()},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("bootstrap_fails_falls_back_to_kickstart", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "bootstrap", domain(m.uid), m.plistPath()}, "", fmt.Errorf("already bootstrapped"))

		if err := m.Start(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := [][]string{
			{"launchctl", "enable", target(m.uid)},
			{"launchctl", "bootstrap", domain(m.uid), m.plistPath()},
			{"launchctl", "kickstart", "-k", target(m.uid)},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("enable_fails_returns_error_no_bootstrap", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "enable", target(m.uid)}, "", fmt.Errorf("enable failed"))

		if err := m.Start(); err == nil {
			t.Fatal("expected error when enable fails")
		}
		want := [][]string{
			{"launchctl", "enable", target(m.uid)},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("both_bootstrap_and_kickstart_fail_returns_error", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "bootstrap", domain(m.uid), m.plistPath()}, "", fmt.Errorf("boom"))
		run.on([]string{"launchctl", "kickstart", "-k", target(m.uid)}, "", fmt.Errorf("boom too"))

		if err := m.Start(); err == nil {
			t.Fatal("expected error when both bootstrap and kickstart fail")
		}
	})
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

func TestLaunchdRestart(t *testing.T) {
	t.Run("kickstart_exactly", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)

		if err := m.Restart(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := [][]string{
			{"launchctl", "kickstart", "-k", target(m.uid)},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("kickstart_error_propagates", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "kickstart", "-k", target(m.uid)}, "", fmt.Errorf("boom"))

		if err := m.Restart(); err == nil {
			t.Fatal("expected error")
		}
	})
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

func TestLaunchdInstall(t *testing.T) {
	run := newRecordingRunner()
	m, fakeBin := newTestManager(t, run)

	if err := m.Install(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	want := [][]string{
		{"launchctl", "enable", target(m.uid)},
		{"launchctl", "bootout", target(m.uid)},
		{"launchctl", "bootstrap", domain(m.uid), m.plistPath()},
	}
	assertCalls(t, run.calls, want)

	data, err := os.ReadFile(m.plistPath())
	if err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	content := string(data)

	if !strings.Contains(content, "dev.agentpod.node") {
		t.Errorf("plist missing label: %s", content)
	}
	if !strings.Contains(content, fmt.Sprintf("<string>%s</string>", fakeBin)) {
		t.Errorf("plist missing binary path %q: %s", fakeBin, content)
	}
	if !strings.Contains(content, "<string>run</string>") {
		t.Errorf("plist missing run argument: %s", content)
	}
	wantLog := filepath.Join(m.home, "Library", "Logs", "agentpod-node.log")
	if got := strings.Count(content, wantLog); got != 2 {
		t.Errorf("plist should reference log path %q twice (stdout+stderr), got %d occurrences: %s", wantLog, got, content)
	}
}

func TestLaunchdInstall_BootoutErrorIgnored(t *testing.T) {
	run := newRecordingRunner()
	m, _ := newTestManager(t, run)
	run.on([]string{"launchctl", "bootout", target(m.uid)}, "", fmt.Errorf("nothing loaded"))

	if err := m.Install(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLaunchdInstall_EnableErrorPropagates(t *testing.T) {
	run := newRecordingRunner()
	m, _ := newTestManager(t, run)
	run.on([]string{"launchctl", "enable", target(m.uid)}, "", fmt.Errorf("enable failed"))

	if err := m.Install(); err == nil {
		t.Fatal("expected error when enable fails")
	}
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

func TestLaunchdUninstall(t *testing.T) {
	t.Run("removes_existing_plist", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		if err := m.Install(); err != nil {
			t.Fatalf("Install setup: %v", err)
		}
		run.calls = nil

		if err := m.Uninstall(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		want := [][]string{
			{"launchctl", "bootout", target(m.uid)},
		}
		assertCalls(t, run.calls, want)

		if _, err := os.Stat(m.plistPath()); !os.IsNotExist(err) {
			t.Errorf("plist should be removed, stat err = %v", err)
		}
	})

	t.Run("idempotent_when_already_absent", func(t *testing.T) {
		run := newRecordingRunner()
		m, _ := newTestManager(t, run)
		run.on([]string{"launchctl", "bootout", target(m.uid)}, "", fmt.Errorf("nothing loaded"))

		if err := m.Uninstall(); err != nil {
			t.Fatalf("expected no error when plist already absent, got: %v", err)
		}
	})
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

func TestLaunchdStatus(t *testing.T) {
	cases := []struct {
		name          string
		install       bool
		printDisabled scriptResult
		printUnit     scriptResult
		wantInstalled bool
		wantEnabled   bool
		wantRunning   bool
		wantPID       int
	}{
		{
			name:          "running_with_pid",
			install:       true,
			printDisabled: scriptResult{out: "", err: nil},
			printUnit:     scriptResult{out: "gui/501/dev.agentpod.node = {\n\tpid = 4242\n\tstate = running\n}", err: nil},
			wantInstalled: true,
			wantEnabled:   true,
			wantRunning:   true,
			wantPID:       4242,
		},
		{
			name:          "stopped",
			install:       true,
			printDisabled: scriptResult{out: "", err: nil},
			printUnit:     scriptResult{out: "", err: fmt.Errorf("could not find service")},
			wantInstalled: true,
			wantEnabled:   true,
			wantRunning:   false,
			wantPID:       0,
		},
		{
			name:          "disabled",
			install:       true,
			printDisabled: scriptResult{out: "\"dev.agentpod.node\" => disabled\n", err: nil},
			printUnit:     scriptResult{out: "", err: fmt.Errorf("could not find service")},
			wantInstalled: true,
			wantEnabled:   false,
			wantRunning:   false,
			wantPID:       0,
		},
		{
			name:          "not_installed",
			install:       false,
			printDisabled: scriptResult{out: "", err: nil},
			printUnit:     scriptResult{out: "", err: fmt.Errorf("could not find service")},
			wantInstalled: false,
			wantEnabled:   true,
			wantRunning:   false,
			wantPID:       0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestManager(t, run)
			run.on([]string{"launchctl", "print-disabled", domain(m.uid)}, tc.printDisabled.out, tc.printDisabled.err)
			run.on([]string{"launchctl", "print", target(m.uid)}, tc.printUnit.out, tc.printUnit.err)

			if tc.install {
				if err := m.Install(); err != nil {
					t.Fatalf("Install setup: %v", err)
				}
				run.calls = nil
			}

			st, err := m.Status()
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if st.Installed != tc.wantInstalled {
				t.Errorf("Installed: got %v want %v", st.Installed, tc.wantInstalled)
			}
			if st.Enabled != tc.wantEnabled {
				t.Errorf("Enabled: got %v want %v", st.Enabled, tc.wantEnabled)
			}
			if st.Running != tc.wantRunning {
				t.Errorf("Running: got %v want %v", st.Running, tc.wantRunning)
			}
			if st.PID != tc.wantPID {
				t.Errorf("PID: got %v want %v", st.PID, tc.wantPID)
			}
			if st.UnitPath != m.plistPath() {
				t.Errorf("UnitPath: got %q want %q", st.UnitPath, m.plistPath())
			}
		})
	}
}
