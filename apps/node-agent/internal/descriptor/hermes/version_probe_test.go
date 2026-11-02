package hermes

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// Hermes's version is read from its installed package metadata, with no
// subprocess: `hermes --version` checks for updates over the network, which is
// exactly the slow path that used to read as "unavailable".
func TestHermesVersionReadsPackageMetadataWithoutRunningHermes(t *testing.T) {
	venv := t.TempDir()
	bin := filepath.Join(venv, "bin")
	distInfo := filepath.Join(venv, "lib", "python3.11", "site-packages", "hermes_agent-0.21.3.dist-info")
	for _, dir := range []string{bin, distInfo} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// The real entry point is a /bin/sh wrapper; it must never be executed here.
	entry := filepath.Join(bin, "hermes")
	if err := os.WriteFile(entry, []byte("#!/bin/sh\necho ran >&2\nexit 7\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distInfo, "METADATA"), []byte("Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.21.3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "hermes")
	if err := os.Symlink(entry, link); err != nil {
		t.Fatal(err)
	}
	got := hermesVersionOf(context.Background(), link)
	if got.Status != descriptor.VersionKnown || got.Version != "0.21.3" {
		t.Fatalf("got %+v", got)
	}
}

// Without metadata the probe falls back to `hermes --version`, reading only the
// first line; the multi-line banner once overflowed a 256-byte cap and read as
// unavailable.
func TestHermesVersionFallsBackToTheFirstLineOfVersionOutput(t *testing.T) {
	dir := t.TempDir()
	entry := filepath.Join(dir, "hermes")
	banner := "#!/bin/sh\nprintf 'Hermes Agent v0.21.5 (2026.9.24) · upstream 1a2b3c4\\n'\n" +
		"i=0; while [ $i -lt 40 ]; do printf 'Install directory: /very/long/path/to/the/hermes/agent/install\\n'; i=$((i+1)); done\n"
	if err := os.WriteFile(entry, []byte(banner), 0o755); err != nil {
		t.Fatal(err)
	}
	got := hermesVersionOf(context.Background(), entry)
	if got.Status != descriptor.VersionKnown || got.Version != "0.21.5" {
		t.Fatalf("got %+v", got)
	}
}

func TestHermesVersionReportsAnAbsentBinaryAsAbsent(t *testing.T) {
	got := hermesVersionOf(context.Background(), "")
	if got.Status != descriptor.VersionAbsent || got.Reason == "" {
		t.Fatalf("got %+v", got)
	}
}
