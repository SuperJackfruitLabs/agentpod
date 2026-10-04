package service

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
)

func TestOTelEnvPathSystemd(t *testing.T) {
	sys, _ := newTestSystemdManager(t, &recordingRunner{}, false)
	if got, err := sys.OTelEnvPath(); err != nil || got != "/etc/agentpod-node/otel.env" {
		t.Errorf("system: %q %v", got, err)
	}
	usr, _ := newTestSystemdManager(t, &recordingRunner{}, true)
	got, err := usr.OTelEnvPath()
	if want := filepath.Join(usr.home, ".config", "agentpod-node", "otel.env"); err != nil || got != want {
		t.Errorf("user: %q %v want %q", got, err, want)
	}
}

func TestOTelEnvPathLaunchdUnsupported(t *testing.T) {
	m := newLaunchdManager(t.TempDir(), 501, nil)
	if _, err := m.OTelEnvPath(); !errors.Is(err, otelenv.ErrUnsupported) {
		t.Errorf("err = %v, want ErrUnsupported", err)
	}
}
