package hermes

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// editableHermes lays out what Hermes's git installer leaves: a checkout with a
// venv inside it, holding an editable install whose metadata says 0.0.0 and
// whose direct_url.json names the checkout.
func editableHermes(t *testing.T, editable bool) (checkout, entry string) {
	t.Helper()
	checkout = t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", checkout, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	if err := os.WriteFile(filepath.Join(checkout, "pyproject.toml"), []byte("version = \"0.0.0\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, ".gitignore"), []byte(".venv/\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-q", "-m", "release")
	git("tag", "-a", "v0.23.1", "-m", "v0.23.1")

	venv := filepath.Join(checkout, ".venv")
	bin := filepath.Join(venv, "bin")
	distInfo := filepath.Join(venv, "lib", "python3.11", "site-packages", "hermes_agent-0.0.0.dist-info")
	for _, dir := range []string{bin, distInfo} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	entry = filepath.Join(bin, "hermes")
	if err := os.WriteFile(entry, []byte("#!/bin/sh\necho ran >&2\nexit 7\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(distInfo, "METADATA"), []byte("Metadata-Version: 2.4\nName: hermes-agent\nVersion: 0.0.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	direct := `{"url":"file://` + checkout + `","dir_info":{"editable":` + map[bool]string{true: "true", false: "false"}[editable] + `}}`
	if err := os.WriteFile(filepath.Join(distInfo, "direct_url.json"), []byte(direct), 0o644); err != nil {
		t.Fatal(err)
	}
	return checkout, entry
}

// Hermes's git installer leaves an editable install whose metadata says 0.0.0.
// The release is the tag the checkout sits on, so the installer's version gate
// can judge it instead of refusing every such station.
func TestHermesVersionReadsTheReleaseTagOfAnEditableCheckout(t *testing.T) {
	checkout, entry := editableHermes(t, true)
	got := hermesVersionOf(context.Background(), entry)
	if got.Status != descriptor.VersionKnown || got.Version != "0.23.1" || !strings.Contains(got.Reason, checkout) {
		t.Fatalf("got %+v", got)
	}
}

// A commit past the tag, or an edited tree, is not the tested release: the
// probe keeps the metadata's placeholder, which the gate refuses.
func TestHermesVersionKeepsThePlaceholderOffAReleaseTag(t *testing.T) {
	t.Run("commit past the tag", func(t *testing.T) {
		checkout, entry := editableHermes(t, true)
		cmd := exec.Command("git", "-C", checkout, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "later")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v\n%s", err, out)
		}
		if got := hermesVersionOf(context.Background(), entry); got.Version != "0.0.0" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("edited tree", func(t *testing.T) {
		checkout, entry := editableHermes(t, true)
		if err := os.WriteFile(filepath.Join(checkout, "pyproject.toml"), []byte("edited\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := hermesVersionOf(context.Background(), entry); got.Version != "0.0.0" {
			t.Fatalf("got %+v", got)
		}
	})
	t.Run("not an editable install", func(t *testing.T) {
		_, entry := editableHermes(t, false)
		if got := hermesVersionOf(context.Background(), entry); got.Version != "0.0.0" {
			t.Fatalf("got %+v", got)
		}
	})
}
