package openclaw

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func TestOpenClawVersionReadsPackageJSONWithoutRunningOpenClaw(t *testing.T) {
	// npm links bin/openclaw to <pkg>/openclaw.mjs; the version sits beside it.
	pkg := t.TempDir()
	if err := os.WriteFile(filepath.Join(pkg, "package.json"), []byte(`{"name":"openclaw","version":"2026.7.1-2"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(pkg, "openclaw.mjs")
	if err := os.WriteFile(entry, []byte("#!/usr/bin/env node\nprocess.exit(1)\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(t.TempDir(), "openclaw")
	if err := os.Symlink(entry, bin); err != nil {
		t.Fatal(err)
	}
	got := openclawVersionOf(context.Background(), bin)
	if got.Status != descriptor.VersionKnown || got.Version != "2026.7.1-2" {
		t.Fatalf("probe = %+v", got)
	}
}

func TestOpenClawVersionReportsAnAbsentBinaryAsAbsent(t *testing.T) {
	if got := openclawVersionOf(context.Background(), ""); got.Status != descriptor.VersionAbsent {
		t.Fatalf("probe = %+v", got)
	}
}
