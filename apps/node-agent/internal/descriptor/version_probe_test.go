package descriptor

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A version probe has three honest outcomes. A probe that ran out of time must
// never be reported as a missing harness or as a version out of range.
func TestProbeVersionSeparatesTheThreeOutcomes(t *testing.T) {
	known := probeVersion(context.Background(), time.Second, func(ctx context.Context) (string, error) { return "0.21.3", nil })
	if known.Status != VersionKnown || known.Version != "0.21.3" {
		t.Fatalf("known: %+v", known)
	}
	failed := probeVersion(context.Background(), time.Second, func(ctx context.Context) (string, error) { return "", errors.New("exit status 1") })
	if failed.Status != VersionUndetermined || failed.Version != "" || failed.Reason == "" {
		t.Fatalf("failed: %+v", failed)
	}
	slow := probeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		<-ctx.Done()
		return "", ctx.Err()
	})
	if slow.Status != VersionUndetermined || !slow.TimedOut || slow.Version != "" {
		t.Fatalf("slow: %+v", slow)
	}
}

// A timed-out probe is retried exactly once; any other failure is not.
func TestProbeVersionRetriesATimeoutOnce(t *testing.T) {
	calls := 0
	got := probeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		calls++
		if calls == 1 {
			<-ctx.Done()
			return "", ctx.Err()
		}
		return "0.21.5", nil
	})
	if got.Status != VersionKnown || got.Version != "0.21.5" || calls != 2 {
		t.Fatalf("got %+v after %d calls", got, calls)
	}
	calls = 0
	probeVersion(context.Background(), 20*time.Millisecond, func(ctx context.Context) (string, error) {
		calls++
		return "", errors.New("not a hermes")
	})
	if calls != 1 {
		t.Fatalf("a non-timeout failure was retried: %d calls", calls)
	}
}

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
	if got.Status != VersionKnown || got.Version != "0.21.3" {
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
	if got.Status != VersionKnown || got.Version != "0.21.5" {
		t.Fatalf("got %+v", got)
	}
}

func TestHermesVersionReportsAnAbsentBinaryAsAbsent(t *testing.T) {
	got := hermesVersionOf(context.Background(), "")
	if got.Status != VersionAbsent || got.Reason == "" {
		t.Fatalf("got %+v", got)
	}
}

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
	if got.Status != VersionKnown || got.Version != "2026.7.1-2" {
		t.Fatalf("probe = %+v", got)
	}
}

func TestOpenClawVersionReportsAnAbsentBinaryAsAbsent(t *testing.T) {
	if got := openclawVersionOf(context.Background(), ""); got.Status != VersionAbsent {
		t.Fatalf("probe = %+v", got)
	}
}
