//go:build linux

package stationfs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func TestStationFilesChild(t *testing.T) {
	if os.Getenv("SALAAM_STATION_FILES_CHILD") != "1" {
		return
	}
	syscall.Umask(0077)
	os.Exit(Entry(os.Stdin, os.Stdout, os.Stderr))
}
func request(t *testing.T, value any) map[string]any {
	t.Helper()
	if m, ok := value.(map[string]any); ok {
		if name, ok := m["root"].(string); ok {
			if st, err := os.Stat(name); err == nil {
				stat := st.Sys().(*syscall.Stat_t)
				if m["root_identity"] == nil || m["root_identity"] == "$ROOT_IDENTITY" {
					m["root_identity"] = hash([]byte(fmt.Sprintf(`{"dev":"%d","inode":"%d"}`, stat.Dev, stat.Ino)))
				}
			}
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestStationFilesChild$")
	cmd.Env = []string{"SALAAM_STATION_FILES_CHILD=1"}
	cmd.Stdin = bytes.NewReader(data)
	var output bytes.Buffer
	cmd.Stdout = &output
	cmd.Stderr = &output
	_ = cmd.Run()
	var result map[string]any
	if json.Unmarshal(output.Bytes(), &result) != nil {
		t.Fatalf("invalid private child receipt: %s", output.String())
	}
	return result
}
func inspect(t *testing.T, root string) map[string]any {
	t.Helper()
	r := request(t, map[string]any{"version": 1, "action": "inspect", "root": root})
	if r["ok"] != true {
		t.Fatal(r)
	}
	return r
}
func patch(t *testing.T, root, tree, path string, before, after *string, id string) map[string]any {
	t.Helper()
	return request(t, map[string]any{"version": 1, "action": "patch", "root": root, "expected_tree": tree, "path": path, "expected_hash": before, "content": after, "request_id": strings.Repeat(id, 64), "deadline_ms": time.Now().Add(4500 * time.Millisecond).UnixMilli()})
}

// Read-only snapshots are intentionally immutable during the test. Restore only
// this test-owned directory's write bit at teardown, before TempDir removes it.
// The ordinary CI job runs without root's discretionary-access bypass.
func snapshotPath(t *testing.T) string {
	t.Helper()
	parent := t.TempDir()
	t.Cleanup(func() {
		if err := filepath.WalkDir(parent, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return os.Chmod(path, 0700)
			}
			return nil
		}); err != nil {
			t.Errorf("restore owned snapshot directory for teardown: %v", err)
		}
	})
	return filepath.Join(parent, "snapshot")
}
func TestLargeStationMetadataLazyReadAndFilteredSnapshot(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "src"), 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 50001; i++ {
		if err := os.WriteFile(filepath.Join(root, "src", fmt.Sprintf("file-%05d.txt", i)), []byte("source\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(root, ".env"), []byte("synthetic-never-export"), 0600)
	index := inspect(t, root)
	if index["files"] != float64(50001) {
		t.Fatal(index)
	}
	listed := request(t, map[string]any{"version": 1, "action": "list", "root": root})
	if len(listed["entries"].([]any)) != 40 || listed["next_offset"] != float64(40) {
		t.Fatal("metadata page was not bounded")
	}
	read := request(t, map[string]any{"version": 1, "action": "read", "root": root, "path": "src/file-00000.txt"})
	if read["content"] != "source\n" || read["sha256"] != hash([]byte("source\n")) {
		t.Fatal(read)
	}
	destination := snapshotPath(t)
	snapshot := request(t, map[string]any{"version": 1, "action": "snapshot", "root": root, "expected_tree": index["tree_digest"], "snapshot": destination, "request_id": strings.Repeat("a", 64)})
	if snapshot["ok"] != true || snapshot["files"] != float64(50001) {
		t.Fatal(snapshot)
	}
	for _, p := range []string{destination, filepath.Join(destination, "src")} {
		st, err := os.Stat(p)
		if err != nil || st.Mode().Perm() != 0555 {
			t.Fatal("snapshot directories must be traversable by the isolated identity", err)
		}
	}
	st, err := os.Stat(filepath.Join(destination, "src/file-00000.txt"))
	if err != nil || st.Mode().Perm() != 0444 {
		t.Fatal("snapshot bytes must be readable by the isolated identity", err)
	}
	if _, err := os.Stat(filepath.Join(destination, ".env")); !os.IsNotExist(err) {
		t.Fatal("excluded credentials entered command snapshot")
	}
	if data, err := os.ReadFile(filepath.Join(destination, "src/file-50000.txt")); err != nil || string(data) != "source\n" {
		t.Fatal("snapshot did not contain actual declared source")
	}
}
func TestStationActualRootOptimisticChangesAndNoReplay(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	_ = os.WriteFile(file, []byte("before"), 0600)
	tree := inspect(t, root)["tree_digest"].(string)
	before := hash([]byte("before"))
	after := "reviewed"
	result := patch(t, root, tree, "file.txt", &before, &after, "a")
	if result["ok"] != true || result["sha256"] != hash([]byte(after)) {
		t.Fatal(result)
	}
	if data, _ := os.ReadFile(file); string(data) != after {
		t.Fatal("reviewed change missed actual root")
	}
	replay := patch(t, root, tree, "file.txt", &before, &after, "a")
	if replay["ok"] != false || replay["effect_state"] != "not_started" {
		t.Fatal("stale apply was replayed")
	}
	tree = inspect(t, root)["tree_digest"].(string)
	before = hash([]byte(after))
	_ = os.WriteFile(file, []byte("human edit"), 0600)
	denied := patch(t, root, tree, "file.txt", &before, &after, "b")
	if denied["ok"] != false || denied["effect_state"] != "not_started" {
		t.Fatal(denied)
	}
	if data, _ := os.ReadFile(file); string(data) != "human edit" {
		t.Fatal("overwrote a human edit")
	}
	tree = inspect(t, root)["tree_digest"].(string)
	created := "new file"
	if patch(t, root, tree, "new.txt", nil, &created, "c")["ok"] != true {
		t.Fatal("new file refused")
	}
	tree = inspect(t, root)["tree_digest"].(string)
	createdHash := hash([]byte(created))
	if patch(t, root, tree, "new.txt", &createdHash, nil, "d")["ok"] != true {
		t.Fatal("reviewed deletion refused")
	}
	if _, err := os.Stat(filepath.Join(root, "new.txt")); !os.IsNotExist(err) {
		t.Fatal("deletion missed actual root")
	}
}
func TestStationTraversalHardlinksSpecialFilesAndExpiredGrantFailClosed(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	_ = os.WriteFile(secret, []byte("synthetic-protected"), 0600)
	_ = os.Symlink(secret, filepath.Join(root, "escape"))
	for _, p := range []string{"escape", "../secret", "/etc/passwd", ".env", "a/../../secret"} {
		if request(t, map[string]any{"version": 1, "action": "read", "root": root, "path": p})["ok"] != false {
			t.Fatalf("unsafe read %q", p)
		}
	}
	_ = os.Remove(filepath.Join(root, "escape"))
	_ = os.Link(secret, filepath.Join(root, "hardlink"))
	if request(t, map[string]any{"version": 1, "action": "inspect", "root": root})["ok"] != false {
		t.Fatal("hardlink source admitted")
	}
	_ = os.Remove(filepath.Join(root, "hardlink"))
	_ = os.Symlink(outside, filepath.Join(root, "dir"))
	if request(t, map[string]any{"version": 1, "action": "read", "root": root, "path": "dir/secret"})["ok"] != false {
		t.Fatal("directory symlink traversed")
	}
	_ = os.Remove(filepath.Join(root, "dir"))
	tree := inspect(t, root)["tree_digest"]
	result := request(t, map[string]any{"version": 1, "action": "patch", "root": root, "path": "new", "content": "denied", "expected_hash": nil, "expected_tree": tree, "request_id": strings.Repeat("e", 64), "deadline_ms": time.Now().Add(-time.Second).UnixMilli()})
	if result["ok"] != false || result["effect_state"] != "not_started" {
		t.Fatal("expired effect grant was used")
	}
	if request(t, map[string]any{"version": 2, "action": "inspect", "root": root})["code"] != "station_request_invalid" {
		t.Fatal("future request accepted")
	}
	if request(t, map[string]any{"version": 1, "action": "inspect", "root": root, "command": "unsafe"})["code"] != "station_request_invalid" {
		t.Fatal("unknown command field accepted")
	}
}

func TestCanonicalPrivateStationRequestCorpus(t *testing.T) {
	data, err := os.ReadFile("testdata/salaam-station-files-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Requests []struct {
			Name    string         `json:"name"`
			Accept  bool           `json:"accept"`
			Setup   string         `json:"setup"`
			Request map[string]any `json:"request"`
		} `json:"requests"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus.Requests {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			_ = os.WriteFile(filepath.Join(root, "file.txt"), []byte("hello\n"), 0600)
			tree := inspect(t, root)["tree_digest"].(string)
			if c.Setup == "symlink" {
				outside := filepath.Join(t.TempDir(), "protected")
				_ = os.WriteFile(outside, []byte("synthetic-only"), 0600)
				_ = os.Symlink(outside, filepath.Join(root, "escape"))
			}
			for k, v := range c.Request {
				switch v {
				case "$ROOT":
					c.Request[k] = root
				case "$TREE":
					c.Request[k] = tree
				case "$SNAPSHOT":
					c.Request[k] = snapshotPath(t)
				case "$DEADLINE":
					c.Request[k] = time.Now().Add(4500 * time.Millisecond).UnixMilli()
				}
			}
			result := request(t, c.Request)
			if (result["ok"] == true) != c.Accept {
				t.Fatalf("unexpected acceptance: %v", result)
			}
		})
	}
}

func TestStationPatchCreatesMissingParentsBeneathRootOnly(t *testing.T) {
	root := t.TempDir()
	tree := inspect(t, root)["tree_digest"].(string)
	content := "answer"
	result := patch(t, root, tree, "runs/run_abc/answer.md", nil, &content, "1")
	if result["ok"] != true {
		t.Fatalf("write under missing parents refused: %v", result)
	}
	created, _ := result["created_directories"].([]any)
	if fmt.Sprint(created) != "[runs runs/run_abc]" {
		t.Fatalf("created directories not recorded: %v", result["created_directories"])
	}
	for _, d := range []string{"runs", "runs/run_abc"} {
		st, err := os.Lstat(filepath.Join(root, d))
		if err != nil || !st.IsDir() || st.Mode().Perm() != 0750 {
			t.Fatalf("%s not a 0750 directory: %v %v", d, st, err)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(root, "runs/run_abc/answer.md")); string(data) != content {
		t.Fatal("file missed its new directory")
	}
	// A second write into the now-existing directory creates nothing.
	tree = inspect(t, root)["tree_digest"].(string)
	more := "handoff"
	second := patch(t, root, tree, "runs/run_abc/handoff.json", nil, &more, "2")
	if second["ok"] != true || second["created_directories"] != nil {
		t.Fatalf("existing parent treated as created: %v", second)
	}
}

func TestStationTreeDigestCoversDirectories(t *testing.T) {
	root := t.TempDir()
	before := inspect(t, root)["tree_digest"].(string)
	_ = os.Mkdir(filepath.Join(root, "empty"), 0700)
	if inspect(t, root)["tree_digest"].(string) == before {
		t.Fatal("a new directory left the tree digest unchanged")
	}
	// Listings are unchanged: directories are digested, not listed as files.
	if fmt.Sprint(inspect(t, root)["files"]) != "0" {
		t.Fatalf("directory counted as a file: %v", inspect(t, root)["files"])
	}
}

func TestStationPatchParentsRefuseEscapesAndNonDirectories(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "file.txt"), []byte("x"), 0600)
	_ = os.Symlink(outside, filepath.Join(root, "link"))
	content := "denied"
	for i, p := range []string{"../escape/a.md", "/abs/a.md", "link/new/a.md", "file.txt/a.md", "a/../../b.md"} {
		// The symlink makes the tree itself refused; a patch must still create nothing.
		tree, _ := request(t, map[string]any{"version": 1, "action": "inspect", "root": root})["tree_digest"].(string)
		if tree == "" {
			tree = strings.Repeat("0", 64)
		}
		result := patch(t, root, tree, p, nil, &content, fmt.Sprintf("%x", i+10))
		if result["ok"] != false {
			t.Fatalf("unsafe parent %q accepted: %v", p, result)
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("created outside the root: %v", entries)
	}
	for _, d := range []string{"escape", "abs", "new", "a", "b.md"} {
		if _, err := os.Lstat(filepath.Join(root, d)); !os.IsNotExist(err) {
			t.Fatalf("stray %s left in the root", d)
		}
	}
	if _, err := os.Lstat(filepath.Join(outside, "new")); !os.IsNotExist(err) {
		t.Fatal("followed the symlinked parent")
	}
}

func TestStationPatchCreatesNoParentsWhenRefusedEarly(t *testing.T) {
	root := t.TempDir()
	tree := inspect(t, root)["tree_digest"]
	result := request(t, map[string]any{"version": 1, "action": "patch", "root": root, "path": "runs/late/a.md", "content": "x", "expected_hash": nil, "expected_tree": tree, "request_id": strings.Repeat("f", 64), "deadline_ms": time.Now().Add(-time.Second).UnixMilli()})
	if result["ok"] != false {
		t.Fatal("expired grant used")
	}
	if _, err := os.Lstat(filepath.Join(root, "runs")); !os.IsNotExist(err) {
		t.Fatal("an expired grant still created directories")
	}
	// A stale expected tree also creates nothing.
	stale := patch(t, root, strings.Repeat("9", 64), "runs/stale/a.md", nil, new(string), "3")
	if stale["ok"] != false {
		t.Fatal("stale tree accepted")
	}
	if _, err := os.Lstat(filepath.Join(root, "runs")); !os.IsNotExist(err) {
		t.Fatal("a stale tree still created directories")
	}
}

func TestStationPatchParentsRefuseAConcurrentChange(t *testing.T) {
	// In-process: the station child is a separate process, so the seam is exercised on parents.
	dir := t.TempDir()
	r, err := openRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(r.fd)
	_, tree, err := r.index()
	if err != nil {
		t.Fatal(err)
	}
	q := Request{DeadlineMs: time.Now().Add(time.Minute).UnixMilli(), deadline: time.Now().Add(time.Minute)}
	// A tree that is no longer the reviewed one creates nothing.
	if _, _, err := r.parents(q, "runs/stale", strings.Repeat("9", 64)); err == nil {
		t.Fatal("a stale tree created directories")
	}
	if _, err := os.Lstat(filepath.Join(dir, "runs")); !os.IsNotExist(err) {
		t.Fatal("a stale tree left directories")
	}
	// The tree changes after the reviewed check: the created directories are not all that changed.
	beforeMkdir = func() { _ = os.WriteFile(filepath.Join(dir, "intruder.txt"), []byte("x"), 0600) }
	t.Cleanup(func() { beforeMkdir = func() {} })
	if _, _, err := r.parents(q, "runs/race", tree); err == nil {
		t.Fatal("a concurrent change was absorbed into the new tree")
	}
	// Without a concurrent change the same call succeeds and reports the directories.
	beforeMkdir = func() {}
	_ = os.Remove(filepath.Join(dir, "intruder.txt"))
	_ = os.RemoveAll(filepath.Join(dir, "runs"))
	_, tree, _ = r.index()
	created, after, err := r.parents(q, "runs/ok", tree)
	if err != nil || fmt.Sprint(created) != "[runs runs/ok]" || after == tree {
		t.Fatalf("clean creation failed: %v %v %v", created, after, err)
	}
}

// New files and directories follow the station's 0027 umask (0640 and 0750) whatever the helper's
// own umask, so the workspace group can read them; a setgid parent's group carries down.
func TestStationPatchModesFollowTheWorkspaceGroup(t *testing.T) {
	old := syscall.Umask(0077)
	defer syscall.Umask(old)
	root := t.TempDir()
	if err := os.Chmod(root, os.ModeSetgid|0770); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(root); st.Mode()&os.ModeSetgid == 0 {
		t.Fatalf("root lost setgid: %v", st.Mode())
	}
	tree := inspect(t, root)["tree_digest"].(string)
	content := "answer"
	if result := patch(t, root, tree, "runs/r/answer.md", nil, &content, "5"); result["ok"] != true {
		t.Fatalf("write refused: %v", result)
	}
	file, _ := os.Stat(filepath.Join(root, "runs/r/answer.md"))
	if file.Mode().Perm() != 0640 {
		t.Fatalf("new file mode %v, want 0640", file.Mode().Perm())
	}
	for _, d := range []string{"runs", "runs/r"} {
		st, _ := os.Stat(filepath.Join(root, d))
		if st.Mode().Perm() != 0750 || st.Mode()&os.ModeSetgid == 0 {
			t.Fatalf("%s mode %v, want setgid 0750", d, st.Mode())
		}
	}
	// An edit keeps the file's own mode.
	_ = os.Chmod(filepath.Join(root, "runs/r/answer.md"), 0600)
	tree = inspect(t, root)["tree_digest"].(string)
	before := hash([]byte(content))
	after := "edited"
	if result := patch(t, root, tree, "runs/r/answer.md", &before, &after, "6"); result["ok"] != true {
		t.Fatalf("edit refused: %v", result)
	}
	if st, _ := os.Stat(filepath.Join(root, "runs/r/answer.md")); st.Mode().Perm() != 0600 {
		t.Fatalf("edit changed the mode to %v", st.Mode().Perm())
	}
}
