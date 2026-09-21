package descriptor

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexRuntimeNoteResolvesBundledEngineInsteadOfHostCLI(t *testing.T) {
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@agentclientprotocol", "codex-acp")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	entry := filepath.Join(pkg, "dist", "index.js")
	write(entry, "")
	write(filepath.Join(pkg, "package.json"), `{"name":"@agentclientprotocol/codex-acp","version":"1.1.14"}`)
	write(filepath.Join(pkg, "node_modules", "@openai", "codex", "package.json"), `{"name":"@openai/codex","version":"0.147.0"}`)
	shim := filepath.Join(root, "codex-acp")
	if err := os.Symlink(entry, shim); err != nil {
		t.Fatal(err)
	}
	note := codexRuntimeNote(shim, "")
	for _, want := range []string{"Next chat:", "1.1.14", "bundled Codex 0.147.0", "update to " + codexACPPackage} {
		if !strings.Contains(note, want) {
			t.Fatalf("%q missing %q", note, want)
		}
	}
	note = codexRuntimeNote(shim, "/custom/codex")
	if !strings.Contains(note, "configured Codex /custom/codex") || strings.Contains(note, "bundled Codex 0.147.0") {
		t.Fatal(note)
	}
	// npm can hoist Codex alongside the adapter instead of nesting it.
	if err := os.Remove(filepath.Join(pkg, "node_modules", "@openai", "codex", "package.json")); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(root, "node_modules", "@openai", "codex", "package.json"), `{"name":"@openai/codex","version":"0.155.0"}`)
	if note = codexRuntimeNote(shim, ""); !strings.Contains(note, "bundled Codex 0.155.0") {
		t.Fatal(note)
	}
}

func TestCodexNativeSkillReadinessUsesSelectedBundledEngine(t *testing.T) {
	home, project, _ := buildCodexFixture(t)
	d := newTestCodex(t, home, false)
	root := t.TempDir()
	pkg := filepath.Join(root, "node_modules", "@agentclientprotocol", "codex-acp")
	write := func(path, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	entry := filepath.Join(pkg, "dist", "index.js")
	write(entry, "")
	write(filepath.Join(pkg, "package.json"), `{"name":"@agentclientprotocol/codex-acp","version":"1.12.0"}`)
	write(filepath.Join(pkg, "node_modules", "@openai", "codex", "package.json"), `{"name":"@openai/codex","version":"0.154.0"}`)
	shim := filepath.Join(root, "codex-acp")
	if err := os.Symlink(entry, shim); err != nil {
		t.Fatal(err)
	}
	d.acpBinary = shim
	got, err := d.NativeSkillReadiness(context.Background(), codexKeyFor(project))
	if err != nil {
		t.Fatal(err)
	}
	if !got.Ready || got.AdapterPath != shim || got.AdapterVersion != "1.12.0" || got.EngineVersion != "0.154.0" {
		t.Fatalf("unexpected readiness: %+v", got)
	}
	// A selected override must not be mistaken for the adapter's tested engine.
	d.codexBinary = "/custom/codex"
	got, err = d.NativeSkillReadiness(context.Background(), codexKeyFor(project))
	if err != nil || got.Ready || !strings.Contains(got.Reason, "CODEX_PATH") {
		t.Fatalf("override readiness: %+v %v", got, err)
	}
}

func TestCodexRuntimeNoteUnknownIsNotAHostVersion(t *testing.T) {
	note := codexRuntimeNote(filepath.Join(t.TempDir(), "standalone-adapter"), "")
	if !strings.Contains(note, "bundled Codex version unknown") {
		t.Fatal(note)
	}
}
