package service

import (
	"strings"
	"testing"
)

func TestNewManager_PlatformSelection(t *testing.T) {
	t.Run("darwin_non_root_returns_launchd_manager", func(t *testing.T) {
		mgr, err := newManager("darwin", 501, nil)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := mgr.(*launchdManager); !ok {
			t.Fatalf("got %T, want *launchdManager", mgr)
		}
	})

	t.Run("darwin_root_is_refused", func(t *testing.T) {
		_, err := newManager("darwin", 0, nil)
		if err == nil {
			t.Fatal("expected error for uid 0")
		}
		if !strings.Contains(err.Error(), "per-user") {
			t.Errorf("error %q should mention per-user install policy", err.Error())
		}
	})

	t.Run("linux_non_root_returns_systemd_manager", func(t *testing.T) {
		run := func(name string, args ...string) (string, error) { return "", nil }
		mgr, err := newManager("linux", 501, run)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if _, ok := mgr.(*systemdManager); !ok {
			t.Fatalf("got %T, want *systemdManager", mgr)
		}
	})

	t.Run("unsupported_platform", func(t *testing.T) {
		_, err := newManager("plan9", 501, nil)
		if err == nil {
			t.Fatal("expected error for unsupported platform")
		}
	})
}

func TestNewManager_UsesRealGOOSAndUID(t *testing.T) {
	// Smoke test on whatever platform CI/dev actually runs on: NewManager
	// must not touch the filesystem or invoke any external command, so a
	// recording Runner that fails every call must still produce either a
	// Manager or a well-formed error, never a panic.
	run := func(name string, args ...string) (string, error) {
		t.Fatalf("NewManager must not execute commands: %s %v", name, args)
		return "", nil
	}
	_, _ = NewManager(run)
}
