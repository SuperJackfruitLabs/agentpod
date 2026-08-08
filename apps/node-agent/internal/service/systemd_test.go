package service

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// newTestSystemdManager builds a systemdManager over a temp home (user
// scope unit dir) and a temp system-unit-dir override (system scope), plus
// a fake binary path, so tests never touch the real systemd or /etc.
func newTestSystemdManager(t *testing.T, run *recordingRunner, userScope bool) (*systemdManager, string) {
	t.Helper()
	home := t.TempDir()
	fakeBin := filepath.Join(t.TempDir(), "agentpod-node")
	m := &systemdManager{
		run:       run.run,
		userScope: userScope,
		home:      home,
		uid:       os.Getuid(),
		binPath: func() (string, error) {
			return fakeBin, nil
		},
	}
	if !userScope {
		m.systemUnitPath = filepath.Join(t.TempDir(), "agentpod-node.service")
	}
	return m, fakeBin
}

// base returns the expected argv prefix for a scope: "systemctl --user" for
// user scope, "systemctl" for system scope.
func base(userScope bool) []string {
	if userScope {
		return []string{"systemctl", "--user"}
	}
	return []string{"systemctl"}
}

// argv concatenates a base prefix with trailing args into one expected
// call.
func argv(base []string, extra ...string) []string {
	out := append([]string{}, base...)
	return append(out, extra...)
}

// bothScopes runs fn once for user scope and once for system scope.
func bothScopes(t *testing.T, fn func(t *testing.T, userScope bool)) {
	t.Helper()
	t.Run("user_scope", func(t *testing.T) { fn(t, true) })
	t.Run("system_scope", func(t *testing.T) { fn(t, false) })
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

func TestSystemdStop(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		t.Run("stop_error_ignored_disable_error_returned", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			run.on(argv(base(userScope), "stop", systemdUnitName), "", fmt.Errorf("not running"))
			run.on(argv(base(userScope), "disable", systemdUnitName), "", fmt.Errorf("disable failed"))

			if err := m.Stop(); err == nil {
				t.Fatal("expected error from disable failure")
			}
			want := [][]string{
				argv(base(userScope), "stop", systemdUnitName),
				argv(base(userScope), "disable", systemdUnitName),
			}
			assertCalls(t, run.calls, want)
		})

		t.Run("stop_error_ignored_disable_succeeds", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			run.on(argv(base(userScope), "stop", systemdUnitName), "", fmt.Errorf("not running"))

			if err := m.Stop(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := [][]string{
				argv(base(userScope), "stop", systemdUnitName),
				argv(base(userScope), "disable", systemdUnitName),
			}
			assertCalls(t, run.calls, want)
		})
	})
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

func TestSystemdStart(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		t.Run("enable_now_exactly", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)

			if err := m.Start(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := [][]string{
				argv(base(userScope), "enable", "--now", systemdUnitName),
			}
			assertCalls(t, run.calls, want)
		})

		t.Run("error_propagates", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			run.on(argv(base(userScope), "enable", "--now", systemdUnitName), "", fmt.Errorf("boom"))

			if err := m.Start(); err == nil {
				t.Fatal("expected error")
			}
		})
	})
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

func TestSystemdRestart(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		t.Run("restart_exactly", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)

			if err := m.Restart(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := [][]string{
				argv(base(userScope), "restart", systemdUnitName),
			}
			assertCalls(t, run.calls, want)
		})

		t.Run("error_propagates", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			run.on(argv(base(userScope), "restart", systemdUnitName), "", fmt.Errorf("boom"))

			if err := m.Restart(); err == nil {
				t.Fatal("expected error")
			}
		})
	})
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

func TestSystemdInstall(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		run := newRecordingRunner()
		m, fakeBin := newTestSystemdManager(t, run, userScope)

		if err := m.Install(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}

		want := [][]string{
			argv(base(userScope), "daemon-reload"),
			argv(base(userScope), "enable", "--now", systemdUnitName),
		}
		assertCalls(t, run.calls, want)

		wantPath := m.unitPath()
		if userScope {
			expected := filepath.Join(m.home, ".config", "systemd", "user", "agentpod-node.service")
			if wantPath != expected {
				t.Fatalf("unitPath: got %q want %q", wantPath, expected)
			}
		} else {
			if wantPath != m.systemUnitPath {
				t.Fatalf("unitPath: got %q want systemUnitPath %q", wantPath, m.systemUnitPath)
			}
		}

		data, err := os.ReadFile(wantPath)
		if err != nil {
			t.Fatalf("unit file not written: %v", err)
		}
		content := string(data)

		wantExecStart := fmt.Sprintf("ExecStart=%s run", fakeBin)
		if !strings.Contains(content, wantExecStart) {
			t.Errorf("unit missing %q: %s", wantExecStart, content)
		}

		if userScope {
			if !strings.Contains(content, "WantedBy=default.target") {
				t.Errorf("user unit missing WantedBy=default.target: %s", content)
			}
			if strings.Contains(content, "User=root") {
				t.Errorf("user unit should not set User=root: %s", content)
			}
		} else {
			if !strings.Contains(content, "WantedBy=multi-user.target") {
				t.Errorf("system unit missing WantedBy=multi-user.target: %s", content)
			}
			if !strings.Contains(content, "User=root") {
				t.Errorf("system unit missing User=root: %s", content)
			}
			if !strings.Contains(content, "StandardOutput=journal") {
				t.Errorf("system unit missing journal logging: %s", content)
			}
			if !strings.Contains(content, "NoNewPrivileges=true") {
				t.Errorf("system unit missing hardening block: %s", content)
			}
		}
	})
}

func TestSystemdInstall_DaemonReloadErrorPropagates(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		run := newRecordingRunner()
		m, _ := newTestSystemdManager(t, run, userScope)
		run.on(argv(base(userScope), "daemon-reload"), "", fmt.Errorf("reload failed"))

		if err := m.Install(); err == nil {
			t.Fatal("expected error when daemon-reload fails")
		}
	})
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

func TestSystemdUninstall(t *testing.T) {
	bothScopes(t, func(t *testing.T, userScope bool) {
		t.Run("removes_existing_unit", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			if err := m.Install(); err != nil {
				t.Fatalf("Install setup: %v", err)
			}
			run.calls = nil

			if err := m.Uninstall(); err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			want := [][]string{
				argv(base(userScope), "disable", "--now", systemdUnitName),
				argv(base(userScope), "daemon-reload"),
			}
			assertCalls(t, run.calls, want)

			if _, err := os.Stat(m.unitPath()); !os.IsNotExist(err) {
				t.Errorf("unit file should be removed, stat err = %v", err)
			}
		})

		t.Run("idempotent_when_already_absent", func(t *testing.T) {
			run := newRecordingRunner()
			m, _ := newTestSystemdManager(t, run, userScope)
			run.on(argv(base(userScope), "disable", "--now", systemdUnitName), "", fmt.Errorf("not loaded"))

			if err := m.Uninstall(); err != nil {
				t.Fatalf("expected no error when unit already absent, got: %v", err)
			}
		})
	})
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

func TestSystemdStatus(t *testing.T) {
	cases := []struct {
		name          string
		install       bool
		isEnabled     scriptResult
		isActive      scriptResult
		mainPID       scriptResult
		wantInstalled bool
		wantEnabled   bool
		wantRunning   bool
		wantPID       int
	}{
		{
			name:          "running_enabled_with_pid",
			install:       true,
			isEnabled:     scriptResult{out: "enabled", err: nil},
			isActive:      scriptResult{out: "active", err: nil},
			mainPID:       scriptResult{out: "4242", err: nil},
			wantInstalled: true,
			wantEnabled:   true,
			wantRunning:   true,
			wantPID:       4242,
		},
		{
			name:          "stopped_but_enabled",
			install:       true,
			isEnabled:     scriptResult{out: "enabled", err: nil},
			isActive:      scriptResult{out: "inactive", err: fmt.Errorf("exit status 3")},
			mainPID:       scriptResult{out: "0", err: nil},
			wantInstalled: true,
			wantEnabled:   true,
			wantRunning:   false,
			wantPID:       0,
		},
		{
			name:          "disabled",
			install:       true,
			isEnabled:     scriptResult{out: "disabled", err: fmt.Errorf("exit status 1")},
			isActive:      scriptResult{out: "inactive", err: fmt.Errorf("exit status 3")},
			mainPID:       scriptResult{out: "0", err: nil},
			wantInstalled: true,
			wantEnabled:   false,
			wantRunning:   false,
			wantPID:       0,
		},
		{
			name:          "not_installed",
			install:       false,
			isEnabled:     scriptResult{out: "", err: fmt.Errorf("No such file or directory")},
			isActive:      scriptResult{out: "inactive", err: fmt.Errorf("exit status 3")},
			mainPID:       scriptResult{out: "0", err: nil},
			wantInstalled: false,
			wantEnabled:   false,
			wantRunning:   false,
			wantPID:       0,
		},
	}

	bothScopes(t, func(t *testing.T, userScope bool) {
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				run := newRecordingRunner()
				m, _ := newTestSystemdManager(t, run, userScope)
				run.on(argv(base(userScope), "is-enabled", systemdUnitName), tc.isEnabled.out, tc.isEnabled.err)
				run.on(argv(base(userScope), "is-active", systemdUnitName), tc.isActive.out, tc.isActive.err)
				run.on(argv(base(userScope), "show", "-p", "MainPID", "--value", systemdUnitName), tc.mainPID.out, tc.mainPID.err)

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
				if st.UnitPath != m.unitPath() {
					t.Errorf("UnitPath: got %q want %q", st.UnitPath, m.unitPath())
				}
			})
		}
	})
}

// ---------------------------------------------------------------------------
// NewManager linux scope selection
// ---------------------------------------------------------------------------

func TestNewManager_LinuxScopeSelection(t *testing.T) {
	t.Run("uid_1000_is_user_scope_no_probe_needed", func(t *testing.T) {
		run := newRecordingRunner()
		mgr, err := newManager("linux", 1000, run.run)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		sm, ok := mgr.(*systemdManager)
		if !ok {
			t.Fatalf("got %T, want *systemdManager", mgr)
		}
		if !sm.userScope {
			t.Error("expected user scope for non-root uid")
		}
		// uid != 0 short-circuits the probe: no `is-active` call.
		if len(run.calls) != 0 {
			t.Errorf("expected no probe calls for uid != 0, got %v", run.calls)
		}
	})

	t.Run("uid_0_probe_fails_is_system_scope", func(t *testing.T) {
		run := newRecordingRunner()
		run.on([]string{"systemctl", "--user", "is-active", systemdUnitName}, "", fmt.Errorf("no such unit"))

		mgr, err := newManager("linux", 0, run.run)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		sm, ok := mgr.(*systemdManager)
		if !ok {
			t.Fatalf("got %T, want *systemdManager", mgr)
		}
		if sm.userScope {
			t.Error("expected system scope when uid 0 and user-unit probe fails")
		}
		want := [][]string{
			{"systemctl", "--user", "is-active", systemdUnitName},
		}
		assertCalls(t, run.calls, want)
	})

	t.Run("uid_0_probe_succeeds_is_user_scope", func(t *testing.T) {
		run := newRecordingRunner()
		run.on([]string{"systemctl", "--user", "is-active", systemdUnitName}, "active", nil)

		mgr, err := newManager("linux", 0, run.run)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		sm, ok := mgr.(*systemdManager)
		if !ok {
			t.Fatalf("got %T, want *systemdManager", mgr)
		}
		if !sm.userScope {
			t.Error("expected user scope when uid 0 but user-unit probe succeeds (mirrors selfupdate.restartService)")
		}
	})
}
