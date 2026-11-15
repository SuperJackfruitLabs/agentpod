package superbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func groupedSpecForTest(t *testing.T) GroupedWorkerSpec {
	t.Helper()
	base, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	return GroupedWorkerSpec{Version: GroupedWorkerVersion, Binding: Binding{BoardID: "brd_example1", CardID: "card_example1", RunID: "run_example1", Epoch: 1}, BenchKey: "fixture", BenchID: strings.Repeat("1", 32), WorkspaceRoot: filepath.Join(base, "data", "benches", "fixture"), Members: []GroupedMember{{Name: "a", RepositorySHA256: strings.Repeat("2", 64), TaskRef: "refs/heads/card/card_example1", ObjectFormat: "sha1", Commit: strings.Repeat("3", 40)}}, Arguments: []string{"/bin/true"}, Environment: map[string]string{}, TimeoutSeconds: 10}
}

func TestGroupedContextPackagesExactBytesOutsideWorkspace(t *testing.T) {
	s := groupedSpecForTest(t)
	parent, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Chmod(parent, 0700); e != nil {
		t.Fatal(e)
	}
	dir, digest, e := PrepareGroupedWorker(parent, s)
	if e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "request.json"))
	if e != nil || groupedSHA(raw) != digest {
		t.Fatal("digest does not bind packaged bytes", e)
	}
	var got GroupedWorkerSpec
	if decodeGrouped(raw, &got) != nil || got.BenchID != s.BenchID || got.Members[0] != s.Members[0] {
		t.Fatal("source binding lost")
	}
	if _, e = os.Stat(filepath.Join(dir, "started")); !os.IsNotExist(e) {
		t.Fatal("preparation consumed launch")
	}
	if e = os.MkdirAll(s.WorkspaceRoot, 0700); e != nil {
		t.Fatal(e)
	}
	if _, _, e = PrepareGroupedWorker(s.WorkspaceRoot, s); e == nil {
		t.Fatal("context inside mutable setup workspace accepted")
	}
}

func TestGroupedContextRejectsAmbiguousAndCredentialInputs(t *testing.T) {
	s := groupedSpecForTest(t)
	raw, _ := json.Marshal(s)
	for name, mutate := range map[string]func(map[string]any){
		"unknown-authority":   func(v map[string]any) { v["checkpoint_confirmed"] = true },
		"null-member":         func(v map[string]any) { v["members"] = []any{nil} },
		"null-environment":    func(v map[string]any) { v["environment"] = nil },
		"reporter-credential": func(v map[string]any) { v["environment"] = map[string]string{"REPORTER_JWT": "fixture"} },
		"outside-selector":    func(v map[string]any) { v["repository_name"] = "../outside" },
		"imprecise-epoch":     func(v map[string]any) { v["binding"].(map[string]any)["epoch"] = float64(1 << 53) },
	} {
		t.Run(name, func(t *testing.T) {
			var v map[string]any
			if json.Unmarshal(raw, &v) != nil {
				t.Fatal("fixture")
			}
			mutate(v)
			changed, _ := json.Marshal(v)
			var got GroupedWorkerSpec
			if decodeGrouped(changed, &got) == nil {
				t.Fatal("ambiguous protected context accepted")
			}
		})
	}
	duplicate := append([]byte(`{"version":"foreign",`), raw[1:]...)
	var got GroupedWorkerSpec
	if decodeGrouped(duplicate, &got) == nil {
		t.Fatal("duplicate context fields accepted")
	}
}

func TestGroupedRegularRefusesSymlinkAndNonRegular(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if e := os.WriteFile(target, []byte("private"), 0600); e != nil {
		t.Fatal(e)
	}
	link := filepath.Join(dir, "link")
	if e := os.Symlink(target, link); e != nil {
		t.Fatal(e)
	}
	if _, e := groupedRegular(link, MaxWorker); e == nil {
		t.Fatal("symlink admitted")
	}
	if _, e := groupedRegular(dir, MaxWorker); e == nil {
		t.Fatal("directory admitted")
	}
}
