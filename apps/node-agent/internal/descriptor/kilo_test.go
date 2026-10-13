package descriptor

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func kiloTestDescriptor(t *testing.T, dataDir string, workspaces func(string) ([]string, error)) *kiloDescriptor {
	t.Helper()
	d := NewKiloFrom(KiloConfig{DataDir: dataDir}).(*kiloDescriptor)
	d.userHome = dataDir
	d.lookPath = func(string) (string, error) { return "", errors.New("not on PATH") }
	d.isExecutable = func(string) bool { return false }
	d.getenv = func(string) string { return "" }
	d.processRunning = func(string) (bool, string) { return false, "" }
	d.workspaces = workspaces
	return d
}

func TestKiloHarnessName(t *testing.T) {
	d := kiloTestDescriptor(t, t.TempDir(), func(string) ([]string, error) { return nil, nil })
	if got := d.Harness(); got != "kilo" {
		t.Fatalf("Harness() = %q, want %q", got, "kilo")
	}
}

// A host where Kilo has never run is not an error — it has no stations.
func TestKiloDetectNoDataDir(t *testing.T) {
	d := kiloTestDescriptor(t, filepath.Join(t.TempDir(), "absent"), func(string) ([]string, error) {
		t.Fatal("the database must not be consulted when the data dir is absent")
		return nil, nil
	})
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v, want nil", err)
	}
	if len(stations) != 0 || stations == nil {
		t.Fatalf("Detect() = %v, want an empty non-nil slice", stations)
	}
}

func TestKiloDetectDedupesAndDropsMissing(t *testing.T) {
	dataDir := t.TempDir()
	wsA := t.TempDir()
	wsB := t.TempDir()
	gone := filepath.Join(t.TempDir(), "deleted")

	d := kiloTestDescriptor(t, dataDir, func(string) ([]string, error) {
		// What the union actually returns: the same workspace from both the
		// project and session queries, plus rows worth dropping.
		return []string{wsA, wsB, wsA, gone, "relative/path", "/"}, nil
	})

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	if len(stations) != 2 {
		t.Fatalf("Detect() = %d stations, want 2", len(stations))
	}
	for _, s := range stations {
		if s.Harness != "kilo" || s.Kind != "leaf" {
			t.Errorf("station %q = harness %q kind %q, want kilo/leaf", s.Key, s.Harness, s.Kind)
		}
		if s.WorkspacePath == nil || s.DisplayName != filepath.Base(*s.WorkspacePath) {
			t.Errorf("station %q has the wrong display name for its workspace", s.Key)
		}
	}
}

func TestKiloDetectReportsUnreadableDatabase(t *testing.T) {
	d := kiloTestDescriptor(t, t.TempDir(), func(string) ([]string, error) {
		return nil, errors.New("sqlite3 query failed: executable file not found in $PATH")
	})
	if _, err := d.Detect(); err == nil {
		t.Fatal("Detect() error = nil, want the database read failure surfaced")
	}
}

func TestKiloDetectCapabilityParity(t *testing.T) {
	dataDir := t.TempDir()
	ws := t.TempDir()
	d := kiloTestDescriptor(t, dataDir, func(string) ([]string, error) { return []string{ws}, nil })

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	for _, want := range []string{"skills.inventory", "health", "logs", "fs.read", "fs.write", "terminal", "cleanup"} {
		if !hasCap(stations[0].Capabilities, want) {
			t.Errorf("capabilities %v missing %q", stations[0].Capabilities, want)
		}
	}
}

// Kilo serves ACP itself, so the chain is one binary — but it is still checked
// rather than assumed: a Chat tab that fails on click is worse than no tab.
func TestKiloACPGatedOnTheCLI(t *testing.T) {
	dataDir := t.TempDir()
	ws := t.TempDir()

	for _, tc := range []struct {
		name     string
		resolves bool
	}{{"cli missing", false}, {"cli resolves", true}} {
		t.Run(tc.name, func(t *testing.T) {
			d := kiloTestDescriptor(t, dataDir, func(string) ([]string, error) { return []string{ws}, nil })
			if tc.resolves {
				d.lookPath = func(name string) (string, error) { return "/usr/local/bin/" + name, nil }
			}
			stations, err := d.Detect()
			if err != nil {
				t.Fatalf("Detect() error = %v", err)
			}
			if got := hasCap(stations[0].Capabilities, "acp"); got != tc.resolves {
				t.Fatalf("acp advertised = %v, want %v", got, tc.resolves)
			}
		})
	}
}

func TestKiloACPCommand(t *testing.T) {
	dataDir := t.TempDir()
	ws := t.TempDir()
	d := kiloTestDescriptor(t, dataDir, func(string) ([]string, error) { return []string{ws}, nil })
	d.lookPath = func(name string) (string, error) { return "/opt/bin/" + name, nil }

	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect() error = %v", err)
	}
	argv, dir, _, err := d.ACPCommand(stations[0].Key)
	if err != nil {
		t.Fatalf("ACPCommand() error = %v", err)
	}
	if len(argv) != 2 || filepath.Base(argv[0]) != kiloBinaryName || argv[1] != "acp" {
		t.Fatalf("argv = %v, want the kilo binary then \"acp\"", argv)
	}
	if dir != ws {
		t.Fatalf("dir = %q, want the station workspace %q", dir, ws)
	}
}

func TestKiloACPCommandUnknownKey(t *testing.T) {
	d := kiloTestDescriptor(t, t.TempDir(), func(string) ([]string, error) { return nil, nil })
	if _, _, _, err := d.ACPCommand("kilo:deadbeef"); err == nil {
		t.Fatal("ACPCommand() on an unknown key = nil error, want a refusal")
	}
}

// The reason this descriptor does not simply reuse opencode's query.
//
// Measured on a live 7.8.8 host: a session in a NON-git directory leaves
// `project` holding only the special `global` row and records the real path on
// `session.directory` alone. Reading `project` alone returns nothing for that
// host, so the workspace an operator is actively working in never becomes a
// station. This builds both shapes into a real SQLite file and asserts the
// union finds them.
func TestKiloWorkspacesFromDBUnionsProjectAndSession(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not installed; this test reads a real database")
	}
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "kilo.db")

	schema := `
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, vcs TEXT);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT);
INSERT INTO project VALUES ('global', '/', NULL);
INSERT INTO project VALUES ('abc123', '/srv/git-workspace', 'git');
INSERT INTO session VALUES ('ses_1', 'global', '/srv/plain-workspace');
INSERT INTO session VALUES ('ses_2', 'abc123', '/srv/git-workspace');
`
	cmd := exec.Command("sqlite3", dbPath)
	cmd.Stdin = strings.NewReader(schema)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("seeding the database: %v: %s", err, out)
	}

	paths, err := kiloWorkspacesFromDB(dbPath)
	if err != nil {
		t.Fatalf("kiloWorkspacesFromDB() error = %v", err)
	}

	found := map[string]bool{}
	for _, p := range paths {
		found[p] = true
	}
	if !found["/srv/git-workspace"] {
		t.Errorf("project.worktree row missing from %v", paths)
	}
	if !found["/srv/plain-workspace"] {
		t.Errorf("session.directory row missing from %v — reading project alone is the opencode blind spot this exists to avoid", paths)
	}
	if found["/"] {
		t.Errorf("the global row's \"/\" must not be a workspace: %v", paths)
	}
}

func TestKiloWorkspacesFromDBAbsentDatabase(t *testing.T) {
	paths, err := kiloWorkspacesFromDB(filepath.Join(t.TempDir(), "absent.db"))
	if err != nil {
		t.Fatalf("an absent database must not be an error, got %v", err)
	}
	if len(paths) != 0 {
		t.Fatalf("paths = %v, want none", paths)
	}
}

func TestKiloCollectLogFilesNewestFirst(t *testing.T) {
	dir := t.TempDir()
	older := filepath.Join(dir, "2026-10-13T000000.log")
	newer := filepath.Join(dir, "2026-10-13T010000.log")
	for _, p := range []string{older, newer} {
		if err := os.WriteFile(p, []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-time.Hour)
	if err := os.Chtimes(older, old, old); err != nil {
		t.Fatal(err)
	}

	files := collectKiloLogFiles(dir)
	if len(files) != 2 {
		t.Fatalf("collectKiloLogFiles() = %v, want both files", files)
	}
	if files[0] != newer {
		t.Fatalf("files[0] = %q, want the newest log %q", files[0], newer)
	}
	if got := collectKiloLogFiles(filepath.Join(dir, "absent")); len(got) != 0 {
		t.Fatalf("a missing log dir must yield nothing, got %v", got)
	}
}
