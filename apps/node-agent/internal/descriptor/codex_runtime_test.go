package descriptor

import (
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

func TestCodexRuntimeNoteUnknownIsNotAHostVersion(t *testing.T) {
	note := codexRuntimeNote(filepath.Join(t.TempDir(), "standalone-adapter"), "")
	if !strings.Contains(note, "bundled Codex version unknown") {
		t.Fatal(note)
	}
}
