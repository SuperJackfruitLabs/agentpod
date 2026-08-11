package gitops

import "testing"

// Real `git status --porcelain=v2 --branch -z --untracked-files=all` output,
// with NULs written explicitly. Records are NUL-terminated; a type-2 (rename)
// record is followed by a SECOND NUL-terminated field holding the old path,
// which is the trap in this format.
const porcelainZ = "# branch.oid 9f1c2ab\x00" +
	"# branch.head feat/agent-work\x00" +
	"# branch.upstream origin/feat/agent-work\x00" +
	"# branch.ab +2 -0\x00" +
	"1 .M N... 100644 100644 100644 aaa bbb src/a.ts\x00" +
	"1 A. N... 000000 100644 100644 000 ccc src/added.ts\x00" +
	"1 .D N... 100644 100644 000000 ddd ddd src/gone.ts\x00" +
	"2 R. N... 100644 100644 100644 eee eee R100 src/new.ts\x00src/old.ts\x00" +
	"? notes with spaces.md\x00" +
	"? build/out.bin\x00"

func TestParsePorcelainReadsTheBranch(t *testing.T) {
	got, err := ParsePorcelainV2([]byte(porcelainZ))
	if err != nil {
		t.Fatalf("ParsePorcelainV2: %v", err)
	}
	if got.Branch != "feat/agent-work" {
		t.Errorf("Branch = %q, want feat/agent-work", got.Branch)
	}
	if got.Head != "9f1c2ab" {
		t.Errorf("Head = %q, want 9f1c2ab", got.Head)
	}
	if got.Upstream != "origin/feat/agent-work" {
		t.Errorf("Upstream = %q", got.Upstream)
	}
	if got.Detached {
		t.Error("Detached should be false on a named branch")
	}
}

func TestParsePorcelainDetachedHead(t *testing.T) {
	// git reports the literal "(detached)" as branch.head.
	in := "# branch.oid 9f1c2ab\x00# branch.head (detached)\x00"
	got, err := ParsePorcelainV2([]byte(in))
	if err != nil {
		t.Fatalf("ParsePorcelainV2: %v", err)
	}
	if !got.Detached {
		t.Error("Detached should be true")
	}
	if got.Branch != "" {
		t.Errorf("Branch = %q, want empty on a detached head", got.Branch)
	}
}

func TestParsePorcelainMapsEachStatusCode(t *testing.T) {
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	want := map[string]FileStatus{
		"src/a.ts":             StatusModified,
		"src/added.ts":         StatusAdded,
		"src/gone.ts":          StatusDeleted,
		"src/new.ts":           StatusRenamed,
		"notes with spaces.md": StatusUntracked,
		"build/out.bin":        StatusUntracked,
	}
	if len(got.Files) != len(want) {
		t.Fatalf("parsed %d files, want %d: %+v", len(got.Files), len(want), got.Files)
	}
	for _, f := range got.Files {
		w, ok := want[f.Path]
		if !ok {
			t.Errorf("unexpected path %q", f.Path)
			continue
		}
		if f.Status != w {
			t.Errorf("%s status = %q, want %q", f.Path, f.Status, w)
		}
	}
}

func TestParsePorcelainKeepsTheOldPathOfARename(t *testing.T) {
	// The rename record's second NUL-terminated field is the old path. Reading
	// it as the next record is the classic bug: it invents a phantom file and
	// loses the rename.
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	for _, f := range got.Files {
		if f.Path == "src/new.ts" {
			if f.OldPath == nil || *f.OldPath != "src/old.ts" {
				t.Fatalf("OldPath = %v, want src/old.ts", f.OldPath)
			}
			return
		}
	}
	t.Fatal("renamed file not found")
}

func TestParsePorcelainUntrackedFilesAreUncounted(t *testing.T) {
	// Counting them needs `git add -N`, which writes to the index of a
	// workspace an agent may be using. Null is the honest answer.
	got, _ := ParsePorcelainV2([]byte(porcelainZ))
	for _, f := range got.Files {
		if f.Status == StatusUntracked && (f.Insertions != nil || f.Deletions != nil) {
			t.Errorf("%s carries line counts; untracked files must not", f.Path)
		}
	}
}

func TestParsePorcelainSkipsIgnoredEntries(t *testing.T) {
	in := "! node_modules/\x00? real.ts\x00"
	got, _ := ParsePorcelainV2([]byte(in))
	if len(got.Files) != 1 || got.Files[0].Path != "real.ts" {
		t.Errorf("ignored entries leaked into the file list: %+v", got.Files)
	}
}

func TestParsePorcelainEmptyInput(t *testing.T) {
	got, err := ParsePorcelainV2(nil)
	if err != nil {
		t.Fatalf("empty input should not error: %v", err)
	}
	if len(got.Files) != 0 {
		t.Errorf("want no files, got %+v", got.Files)
	}
}

func TestParseNumstatCountsLines(t *testing.T) {
	in := "12\t3\tsrc/a.ts\x00"
	got, err := ParseNumstatZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNumstatZ: %v", err)
	}
	if got["src/a.ts"].Insertions != 12 || got["src/a.ts"].Deletions != 3 {
		t.Errorf("got %+v", got["src/a.ts"])
	}
}

func TestParseNumstatMarksBinary(t *testing.T) {
	// git writes "-" for both counts on a binary file.
	in := "-\t-\tlogo.png\x00"
	got, _ := ParseNumstatZ([]byte(in))
	if !got["logo.png"].Binary {
		t.Error("logo.png should be marked binary")
	}
}

func TestParseNumstatRenameUsesTwoExtraFields(t *testing.T) {
	// For a rename with -z, the path field is EMPTY and the old and new paths
	// follow as two separate NUL-terminated fields, in that order.
	in := "1\t1\t\x00src/old.ts\x00src/new.ts\x00"
	got, err := ParseNumstatZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNumstatZ: %v", err)
	}
	if _, ok := got["src/new.ts"]; !ok {
		t.Fatalf("rename should be keyed by the NEW path, got %+v", got)
	}
	if got["src/new.ts"].Insertions != 1 {
		t.Errorf("got %+v", got["src/new.ts"])
	}
}

func TestParseNameStatusZ(t *testing.T) {
	// `git diff --name-status -z`: status field, then path(s), each NUL-terminated.
	in := "M\x00src/a.ts\x00A\x00src/b.ts\x00D\x00src/c.ts\x00R100\x00src/old.ts\x00src/new.ts\x00T\x00src/link\x00"
	got, err := ParseNameStatusZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseNameStatusZ: %v", err)
	}
	if len(got) != 5 {
		t.Fatalf("parsed %d files, want 5: %+v", len(got), got)
	}
	want := []struct {
		path   string
		status FileStatus
	}{
		{"src/a.ts", StatusModified},
		{"src/b.ts", StatusAdded},
		{"src/c.ts", StatusDeleted},
		{"src/new.ts", StatusRenamed},
		{"src/link", StatusTypeChanged},
	}
	for i, w := range want {
		if got[i].Path != w.path || got[i].Status != w.status {
			t.Errorf("[%d] = %s/%s, want %s/%s", i, got[i].Path, got[i].Status, w.path, w.status)
		}
	}
	if got[3].OldPath == nil || *got[3].OldPath != "src/old.ts" {
		t.Errorf("rename OldPath = %v", got[3].OldPath)
	}
}

func TestParseCommitsZ(t *testing.T) {
	// --format uses %x1f between fields; -z puts a NUL between commits.
	in := "9f1c2ab0000000000000000000000000000000aa\x1f9f1c2ab\x1fwire the thing up\x1fcodex\x1f2026-08-11T09:15:00Z\x00" +
		"1111111000000000000000000000000000000bb\x1f1111111\x1ffix: subject with, punctuation\x1fRakesh\x1f2026-08-10T22:01:00Z\x00"
	got, err := ParseCommitsZ([]byte(in))
	if err != nil {
		t.Fatalf("ParseCommitsZ: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("parsed %d commits, want 2", len(got))
	}
	if got[0].ShortSHA != "9f1c2ab" || got[0].Subject != "wire the thing up" || got[0].Author != "codex" {
		t.Errorf("got %+v", got[0])
	}
	if got[1].Subject != "fix: subject with, punctuation" {
		t.Errorf("subject mangled: %q", got[1].Subject)
	}
}

func TestParseCommitsZEmpty(t *testing.T) {
	got, err := ParseCommitsZ(nil)
	if err != nil {
		t.Fatalf("empty input should not error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("want none, got %+v", got)
	}
}
