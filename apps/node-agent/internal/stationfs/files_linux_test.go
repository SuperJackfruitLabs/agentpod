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
