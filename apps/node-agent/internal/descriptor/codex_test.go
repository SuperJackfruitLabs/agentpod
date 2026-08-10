package descriptor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// codexExpectedCaps is exactly what a codex station advertises. "acp" is
// present because *codexDescriptor implements ACPCommander (via the external
// codex-acp adapter — see ACPCommand), which is what the contract in
// descriptor.go ties the capability to.
var codexExpectedCaps = []string{"health", "logs", "fs.read", "fs.write", "terminal", "cleanup", "acp"}

// buildCodexFixture writes a realistic ~/.codex/config.toml containing three
// [projects."<path>"] tables — one path with a space in it, one that does not
// exist on disk — plus unrelated top-level keys and unrelated tables that must
// be ignored. It returns the codex home and the two project dirs that exist.
func buildCodexFixture(t *testing.T) (home, projA, projB string) {
	t.Helper()
	root := t.TempDir()

	home = filepath.Join(root, ".codex")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("MkdirAll codex home: %v", err)
	}

	projA = filepath.Join(root, "Projects", "periscope")
	projB = filepath.Join(root, "Projects", "my project") // path with a space
	gone := filepath.Join(root, "Projects", "deleted-workspace")
	for _, p := range []string{projA, projB} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatalf("MkdirAll project: %v", err)
		}
	}

	cfg := fmt.Sprintf(`model = "gpt-5-codex"
model_reasoning_effort = "high"
personality = "concise"

[tui]
notifications = true

[projects.%q]
trust_level = "trusted"

[projects.%q]
trust_level = "trusted"

# a project directory that has since been deleted
[projects.%q]
trust_level = "trusted"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[shell_environment_policy]
inherit = "all"
`, projA, projB, gone)

	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("WriteFile config.toml: %v", err)
	}
	return home, projA, projB
}

// newTestCodex returns the concrete descriptor with its host-touching process
// probe stubbed, so no test depends on codex being installed and none spawns a
// pgrep-visible child.
func newTestCodex(t *testing.T, home string, running bool) *codexDescriptor {
	t.Helper()
	d, ok := NewCodex(home).(*codexDescriptor)
	if !ok {
		t.Fatalf("NewCodex did not return *codexDescriptor")
	}
	d.processRunning = func(string) (bool, string) { return running, "" }
	return d
}

func codexKeyFor(path string) string {
	h := sha256.Sum256([]byte(path))
	return fmt.Sprintf("codex:%x", h[:4])
}

// --- Detect ---

func TestCodexDetect_ProjectTables(t *testing.T) {
	home, projA, projB := buildCodexFixture(t)
	d := NewCodex(home)

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 2 {
		t.Fatalf("expected 2 stations (the deleted path filtered out), got %d: %+v", len(stations), stations)
	}

	byPath := map[string]Station{}
	keyRe := regexp.MustCompile(`^codex:[0-9a-f]{8}$`)
	for _, s := range stations {
		if s.Harness != "codex" {
			t.Errorf("station %s: harness = %q, want codex", s.Key, s.Harness)
		}
		if s.Kind != "leaf" {
			t.Errorf("station %s: kind = %q, want leaf", s.Key, s.Kind)
		}
		if s.ParentKey != nil {
			t.Errorf("station %s: parentKey = %v, want nil", s.Key, *s.ParentKey)
		}
		if !keyRe.MatchString(s.Key) {
			t.Errorf("key %q does not match codex:<8 hex>", s.Key)
		}
		if s.WorkspacePath == nil {
			t.Fatalf("station %s: workspacePath is nil", s.Key)
		}
		if !reflect.DeepEqual(s.Capabilities, codexExpectedCaps) {
			t.Errorf("station %s: capabilities = %v, want exactly %v", s.Key, s.Capabilities, codexExpectedCaps)
		}
		var hasACP bool
		for _, c := range s.Capabilities {
			if c == "acp" {
				hasACP = true
			}
		}
		if !hasACP {
			t.Errorf("station %s must advertise acp: the descriptor implements ACPCommander", s.Key)
		}
		byPath[*s.WorkspacePath] = s
	}

	for _, p := range []string{projA, projB} {
		s, ok := byPath[p]
		if !ok {
			t.Fatalf("no station for project %q (got %v)", p, byPath)
		}
		if want := filepath.Base(p); s.DisplayName != want {
			t.Errorf("station %s: displayName = %q, want %q", s.Key, s.DisplayName, want)
		}
		if want := codexKeyFor(p); s.Key != want {
			t.Errorf("station for %q: key = %q, want %q", p, s.Key, want)
		}
	}
}

func TestCodexDetect_KeysStableAcrossCalls(t *testing.T) {
	home, _, _ := buildCodexFixture(t)
	d := NewCodex(home)

	first, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect #1: %v", err)
	}
	second, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect #2: %v", err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("Detect is not stable across calls:\nfirst  = %+v\nsecond = %+v", first, second)
	}
}

func TestCodexDetect_NoProjectsReturnsEmpty(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, ".codex")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	// A real-looking config with no [projects."…"] tables at all.
	cfg := "model = \"gpt-5-codex\"\n\n[tui]\nnotifications = true\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	stations, err := NewCodex(home).Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if stations == nil {
		t.Fatal("Detect returned nil, want non-nil empty slice")
	}
	if len(stations) != 0 {
		t.Fatalf("expected 0 stations, got %d: %+v", len(stations), stations)
	}
}

func TestCodexDetect_MissingHomeReturnsEmpty(t *testing.T) {
	stations, err := NewCodex(filepath.Join(t.TempDir(), "no-such-codex-home")).Detect()
	if err != nil {
		t.Fatalf("Detect on missing home: %v", err)
	}
	if stations == nil {
		t.Fatal("Detect returned nil for missing home, want non-nil empty slice")
	}
	if len(stations) != 0 {
		t.Fatalf("expected empty stations for missing home, got %d", len(stations))
	}
}

// A relative key can never be a workspace root. Left unchecked it would be
// stat'd against the SERVICE's cwd — and that same resolution then becomes the
// fs.read root and, worse, the CleanApply root. The fixture chdir's somewhere the
// relative path really does resolve, so a station appearing would be the actual
// bug and not a missing directory.
func TestCodexDetect_RejectsRelativeProjectPaths(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, ".codex")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "relative", "workspace"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	cfg := "[projects.\"relative/workspace\"]\ntrust_level = \"trusted\"\n" +
		"[projects.\"../escaped\"]\ntrust_level = \"trusted\"\n"
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	t.Chdir(root)

	stations, err := NewCodex(home).Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 0 {
		t.Fatalf("expected no stations from relative project keys, got %+v", stations)
	}
}

// Only "it is gone" removes a station. A transient stat failure — EACCES on a
// briefly-unavailable mount, say — must NOT make a station vanish from the fleet
// view: the harness config still lists it, and a station blinking out of the
// console is a worse lie than one that is temporarily unreachable. Matches
// claude-code, which drops on os.IsNotExist only.
func TestCodexDetect_KeepsStationWhenStatFailsWithoutNotExist(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: a 0000 directory would still be traversable")
	}
	root := t.TempDir()
	home := filepath.Join(root, ".codex")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	guarded := filepath.Join(root, "guarded")
	proj := filepath.Join(guarded, "workspace")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	cfg := fmt.Sprintf("[projects.%q]\ntrust_level = \"trusted\"\n", proj)
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte(cfg), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	// Unreadable parent → stat(proj) fails with EACCES, not ENOENT. Restored so
	// t.TempDir's cleanup can still remove the tree.
	if err := os.Chmod(guarded, 0o000); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(guarded, 0o755) })
	if _, err := os.Stat(proj); err == nil || os.IsNotExist(err) {
		t.Skipf("could not provoke a non-ENOENT stat error on this platform (got %v)", err)
	}

	stations, err := NewCodex(home).Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) != 1 {
		t.Fatalf("expected the station to survive a non-ENOENT stat error, got %+v", stations)
	}
	if stations[0].Key != codexKeyFor(proj) {
		t.Errorf("station key = %q, want %q", stations[0].Key, codexKeyFor(proj))
	}
}

func TestCodexHarness(t *testing.T) {
	d := NewCodex("")
	if d.Harness() != "codex" {
		t.Errorf("Harness: want codex, got %s", d.Harness())
	}
}

// --- config.toml scanning ---

func TestParseCodexProjectPaths(t *testing.T) {
	cfg := `model = "gpt-5-codex"
projects = "not a table"

[projects."/srv/plain"]
trust_level = "trusted"

[ projects . "/srv/spaced key" ]
trust_level = "trusted"

[projects.'/srv/literal quoted']
trust_level = "trusted"

[projects."/srv/plain"]
trust_level = "trusted"

[projects."/srv/nested".history]
enabled = true

#[projects."/srv/commented-out"]

[projects]
foo = 1

[projects.bare_key]
trust_level = "trusted"

[[projects_array]]
name = "not a project"

[project_settings."/srv/other-table"]
x = 1
`
	got := parseCodexProjectPaths([]byte(cfg))
	want := []string{
		"/srv/plain",
		"/srv/spaced key",
		"/srv/literal quoted",
		"/srv/nested",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseCodexProjectPaths =\n  %q\nwant\n  %q", got, want)
	}
}

func TestParseCodexProjectPaths_Escapes(t *testing.T) {
	cfg := "[projects.\"/srv/quote\\\"dir\"]\ntrust_level = \"trusted\"\n" +
		"[projects.\"/srv/back\\\\slash\"]\ntrust_level = \"trusted\"\n"
	got := parseCodexProjectPaths([]byte(cfg))
	want := []string{`/srv/quote"dir`, `/srv/back\slash`}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseCodexProjectPaths = %q, want %q", got, want)
	}
}

// --- fs.read ---

func TestCodexListDirAndReadFile(t *testing.T) {
	home, projA, _ := buildCodexFixture(t)
	d := NewCodex(home)
	key := codexKeyFor(projA)

	if err := os.MkdirAll(filepath.Join(projA, "src"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projA, "README.md"), []byte("hello codex\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projA, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	entries, err := d.ListDir(key, "")
	if err != nil {
		t.Fatalf("ListDir root: %v", err)
	}
	types := map[string]string{}
	for _, e := range entries {
		types[e.Name] = e.Type
	}
	if types["README.md"] != "file" {
		t.Errorf("README.md type = %q, want file (entries=%+v)", types["README.md"], entries)
	}
	if types["src"] != "dir" {
		t.Errorf("src type = %q, want dir (entries=%+v)", types["src"], entries)
	}

	sub, err := d.ListDir(key, "src")
	if err != nil {
		t.Fatalf("ListDir src: %v", err)
	}
	if len(sub) != 1 || sub[0].Name != "main.go" || sub[0].Path != filepath.Join("src", "main.go") {
		t.Fatalf("ListDir src = %+v, want one entry src/main.go", sub)
	}

	content, _, truncated, err := d.ReadFile(key, "README.md", 0)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(content) != "hello codex\n" {
		t.Errorf("ReadFile content = %q, want %q", content, "hello codex\n")
	}
	if truncated {
		t.Error("ReadFile truncated = true, want false")
	}

	content, _, truncated, err = d.ReadFile(key, "README.md", 5)
	if err != nil {
		t.Fatalf("ReadFile truncating: %v", err)
	}
	if string(content) != "hello" || !truncated {
		t.Errorf("ReadFile(maxBytes=5) = %q truncated=%v, want %q true", content, truncated, "hello")
	}

	// Escapes are rejected, unknown keys error.
	if _, err := d.ListDir(key, "../.."); err == nil {
		t.Error("ListDir with escaping rel: expected error")
	}
	if _, err := d.ListDir("codex:deadbeef", ""); err == nil {
		t.Error("ListDir with unknown key: expected error")
	}
	if _, _, _, err := d.ReadFile("codex:deadbeef", "README.md", 0); err == nil {
		t.Error("ReadFile with unknown key: expected error")
	}
}

// --- health ---

func TestCodexHealth(t *testing.T) {
	home, projA, _ := buildCodexFixture(t)
	d := newTestCodex(t, home, true)

	h, err := d.Health(codexKeyFor(projA))
	if err != nil {
		t.Fatalf("Health: %v", err)
	}
	if !h.Running {
		t.Error("Health.Running = false, want true (stubbed probe)")
	}
	if h.Note != nil {
		t.Errorf("Health.Note = %q, want nil", *h.Note)
	}

	d2 := newTestCodex(t, home, false)
	h2, err := d2.Health(codexKeyFor(projA))
	if err != nil {
		t.Fatalf("Health (stopped): %v", err)
	}
	if h2.Running {
		t.Error("Health.Running = true, want false (stubbed probe)")
	}

	if _, err := d.Health("codex:deadbeef"); err == nil {
		t.Error("Health with unknown key: expected error")
	}
}

// --- cleanup ---

func TestCodexCleanPlanAndApply(t *testing.T) {
	home, projA, _ := buildCodexFixture(t)
	d, ok := NewCodex(home).(Cleaner)
	if !ok {
		t.Fatal("codex descriptor must implement Cleaner to advertise the cleanup capability")
	}
	key := codexKeyFor(projA)

	if err := os.MkdirAll(filepath.Join(projA, ".cache"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projA, ".cache", "blob"), []byte("0123456789"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	plan, err := d.CleanPlan(key)
	if err != nil {
		t.Fatalf("CleanPlan: %v", err)
	}
	found := false
	for _, item := range plan {
		if item.Path == ".cache" {
			found = true
			if item.Size != 10 {
				t.Errorf(".cache size = %d, want 10", item.Size)
			}
		}
	}
	if !found {
		t.Fatalf("CleanPlan = %+v, want a .cache item", plan)
	}

	freed, err := d.CleanApply(key, []string{".cache"})
	if err != nil {
		t.Fatalf("CleanApply: %v", err)
	}
	if freed != 10 {
		t.Errorf("CleanApply freed = %d, want 10", freed)
	}
	if _, err := os.Stat(filepath.Join(projA, ".cache")); !os.IsNotExist(err) {
		t.Error(".cache still present after CleanApply")
	}
}

// --- logs ---

func TestCodexTailLogs(t *testing.T) {
	home, projA, _ := buildCodexFixture(t)
	d := NewCodex(home)

	sessDir := filepath.Join(home, "sessions", "2026", "08", "10")
	if err := os.MkdirAll(sessDir, 0o755); err != nil {
		t.Fatalf("MkdirAll sessions: %v", err)
	}
	rollout := filepath.Join(sessDir, "rollout-2026-08-10T09-00-00-abcdef.jsonl")
	if err := os.WriteFile(rollout, []byte("{\"type\":\"turn\"}\n"), 0o644); err != nil {
		t.Fatalf("WriteFile rollout: %v", err)
	}

	var sb strings.Builder
	err := d.TailLogs(context.Background(), codexKeyFor(projA), false, func(b []byte) error {
		sb.Write(b)
		return nil
	})
	if err != nil {
		t.Fatalf("TailLogs: %v", err)
	}
	if !strings.Contains(sb.String(), `{"type":"turn"}`) {
		t.Fatalf("TailLogs emitted %q, want the rollout content", sb.String())
	}

	if err := d.TailLogs(context.Background(), "codex:deadbeef", false, func([]byte) error { return nil }); err == nil {
		t.Error("TailLogs with unknown key: expected error")
	}
}
