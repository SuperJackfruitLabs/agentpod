package descriptor

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

// WorkspaceRooter is an OPTIONAL interface: the root a descriptor's ReadFile passes to safeJoin.
// Linking an artifact (offset reads, fs.walk) needs it; a descriptor without it refuses those.
type WorkspaceRooter interface {
	WorkspaceRoot(key string) (string, error)
}

// MaxChunk caps one offset read.
const MaxChunk = 4 << 20

// deniedRules is the spec §8 default denylist. It mirrors Superlibrary's DENIED_RULES
// (packages/contract/src/paths.ts) and may only be stricter. Matching ignores case and strips
// trailing dots and spaces from each segment. Keep the two lists in step.
var deniedRules = []struct {
	rule string
	test func(segs []string) bool
}{
	{".env*", anySeg(func(s string) bool { return strings.HasPrefix(s, ".env") })},
	{".ssh/", dirSeg(".ssh")},
	{".gnupg/", dirSeg(".gnupg")},
	{"*.pem", base(func(b string) bool { return strings.HasSuffix(b, ".pem") })},
	{"*.key", base(func(b string) bool { return strings.HasSuffix(b, ".key") })},
	{"id_*", base(func(b string) bool { return strings.HasPrefix(b, "id_") })},
	{".git/", dirSeg(".git")},
	{".netrc", base(func(b string) bool { return b == ".netrc" })},
	{".npmrc", base(func(b string) bool { return b == ".npmrc" })},
	{".pypirc", base(func(b string) bool { return b == ".pypirc" })},
	{".git-credentials", base(func(b string) bool { return b == ".git-credentials" })},
	{"cloud credentials", func(s []string) bool {
		return dirSeg(".aws")(s) || dirSeg(".azure")(s) || dirSeg(".kube")(s) || sub(".config", "gcloud")(s) ||
			sub(".docker", "config.json")(s) ||
			base(func(b string) bool { return b == "application_default_credentials.json" || b == "credentials.json" })(s)
	}},
	{"harness files", func(s []string) bool {
		for _, d := range []string{".claude", ".codex", ".gemini", ".cursor", ".hermes", ".openclaw", ".opencode", ".pi"} {
			if dirSeg(d)(s) {
				return true
			}
		}
		return base(func(b string) bool { return b == ".claude.json" || b == "auth.json" || b == ".credentials.json" })(s) ||
			sub(".config", "opencode")(s) || sub(".local", "share", "opencode")(s) || sub(".config", "goose")(s)
	}},
}

func anySeg(pred func(string) bool) func([]string) bool {
	return func(s []string) bool {
		for _, x := range s {
			if pred(x) {
				return true
			}
		}
		return false
	}
}

func dirSeg(name string) func([]string) bool {
	return func(s []string) bool {
		for _, x := range s[:len(s)-1] {
			if x == name {
				return true
			}
		}
		return false
	}
}

func base(pred func(string) bool) func([]string) bool {
	return func(s []string) bool { return pred(s[len(s)-1]) }
}

// sub matches the segments parts as a consecutive run anywhere in the path.
func sub(parts ...string) func([]string) bool {
	return func(s []string) bool {
		for i := 0; i+len(parts) <= len(s); i++ {
			ok := true
			for j, p := range parts {
				if s[i+j] != p {
					ok = false
					break
				}
			}
			if ok {
				return true
			}
		}
		return false
	}
}

// Denied reports the rule a relative path breaks, if any.
func Denied(rel string) (string, bool) {
	var segs []string
	for _, s := range strings.Split(strings.ReplaceAll(rel, "\\", "/"), "/") {
		if s == "" || s == "." {
			continue
		}
		segs = append(segs, strings.ToLower(strings.TrimRight(s, ". ")))
	}
	if len(segs) == 0 {
		return "", false
	}
	for _, r := range deniedRules {
		if r.test(segs) {
			return r.rule, true
		}
	}
	return "", false
}

// ErrDenied marks a path the denylist refuses.
var ErrDenied = errors.New("path denied")

// ReadAt reads up to max bytes of rel from offset, inside root (symlinks resolved, spec §8).
// It returns the bytes, the file's size, and whether the read reached the end.
func ReadAt(root, rel string, offset, max int64) ([]byte, int64, bool, error) {
	if rule, ok := Denied(rel); ok {
		return nil, 0, false, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
	}
	if offset < 0 {
		return nil, 0, false, fmt.Errorf("offset must not be negative")
	}
	if max <= 0 || max > MaxChunk {
		max = MaxChunk
	}
	target, err := fsops.Jail(root, rel)
	if err != nil {
		return nil, 0, false, err
	}
	// Resolve symlinks and check the denylist again against what will really be read: an
	// in-root link (notes.txt -> .env, cfg -> .git) must not launder a denied path.
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, 0, false, err
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, 0, false, err
	}
	real, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || real == ".." || strings.HasPrefix(real, ".."+string(filepath.Separator)) {
		return nil, 0, false, fsops.ErrEscape
	}
	if rule, ok := Denied(filepath.ToSlash(real)); ok {
		return nil, 0, false, fmt.Errorf("%w: %s resolves to %s (%s)", ErrDenied, rel, real, rule)
	}
	// Open through os.Root so a directory swapped for a symlink between the checks above and
	// the open cannot lead out of the root.
	r, err := os.OpenRoot(resolvedRoot)
	if err != nil {
		return nil, 0, false, err
	}
	defer r.Close()
	f, err := r.Open(real)
	if err != nil {
		return nil, 0, false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, 0, false, fmt.Errorf("%s is not a regular file", rel)
	}
	buf := make([]byte, max)
	n, err := f.ReadAt(buf, offset)
	if err != nil && err != io.EOF {
		return nil, 0, false, err
	}
	return buf[:n], info.Size(), offset+int64(n) >= info.Size(), nil
}

// WalkFile is one regular file in a folder manifest. Path is relative to the walked folder;
// walking a single file lists it once with Path "".
type WalkFile struct {
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// WalkSkip is an entry the manifest leaves out, and why.
type WalkSkip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// WalkResult is the fs.walk result.
type WalkResult struct {
	Root     string     `json:"root"`
	Files    []WalkFile `json:"files"`
	Skipped  []WalkSkip `json:"skipped"`
	TooMany  bool       `json:"tooMany"`
	TooLarge bool       `json:"tooLarge"`
}

// maxWalkSkipped caps the skipped list and maxWalkEntries the entries visited, so a huge tree of
// folders, links or denied files cannot make the walk (or its answer) unbounded; past either, the
// walk stops and reports tooMany.
const (
	maxWalkSkipped = 500
	maxWalkEntries = 20000
)

// walkErr hides host paths: callers get the requested relative path, never an absolute one.
func walkErr(rel string, err error) error {
	if errors.Is(err, fsops.ErrEscape) || errors.Is(err, ErrDenied) {
		return err
	}
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("%s: not found", rel)
	}
	return fmt.Errorf("%s: cannot be walked", rel)
}

// Walk lists the regular files under rel (spec §8: inside the root, nothing denied, no symlink
// followed), stopping at maxFiles or maxBytes. Folder caps are Superlibrary's (500 files, 100 MB).
// The denylist is applied to rel itself, to where rel really resolves, and to the path of every
// entry from the root (not only from the walked folder). A symlink entry is never followed or
// listed, whatever its target.
func Walk(root, rel string, maxFiles int, maxBytes int64) (WalkResult, error) {
	if maxFiles <= 0 || maxFiles > 500 {
		maxFiles = 500
	}
	if maxBytes <= 0 || maxBytes > 100<<20 {
		maxBytes = 100 << 20
	}
	if rule, ok := Denied(rel); ok {
		return WalkResult{}, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
	}
	target, err := fsops.Jail(root, rel)
	if err != nil {
		return WalkResult{}, walkErr(rel, err)
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return WalkResult{}, walkErr(rel, err)
	}
	base, err := filepath.EvalSymlinks(target)
	if err != nil {
		return WalkResult{}, walkErr(rel, err)
	}
	real, err := filepath.Rel(resolvedRoot, base)
	if err != nil || real == ".." || strings.HasPrefix(real, ".."+string(filepath.Separator)) {
		return WalkResult{}, fsops.ErrEscape
	}
	real = filepath.ToSlash(real)
	if rule, ok := Denied(real); ok {
		return WalkResult{}, fmt.Errorf("%w: %s resolves to %s (%s)", ErrDenied, rel, real, rule)
	}
	res := WalkResult{Root: rel, Files: []WalkFile{}, Skipped: []WalkSkip{}}
	var total int64
	add := func(r string, size int64) (stop bool) {
		if len(res.Files) == maxFiles {
			res.TooMany = true
			return true
		}
		total += size
		if total > maxBytes {
			res.TooLarge = true
			return true
		}
		res.Files = append(res.Files, WalkFile{r, size})
		return false
	}
	st, err := os.Stat(base)
	if err != nil {
		return WalkResult{}, walkErr(rel, err)
	}
	if st.IsDir() {
		// A folder is judged by what it would contain: ".ssh" and ".git" are denied as
		// directories, which Denied only sees from a path beneath them.
		for _, p := range []string{path.Join(rel, "x"), path.Join(real, "x")} {
			if rule, ok := Denied(p); ok {
				return WalkResult{}, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
			}
		}
	}
	if !st.IsDir() {
		if !st.Mode().IsRegular() {
			return WalkResult{}, fmt.Errorf("%s is not a regular file or folder", rel)
		}
		add("", st.Size())
		return res, nil
	}
	visited := 0
	// skip records one skipped entry; past the cap the walk stops.
	skip := func(r, reason string) error {
		if len(res.Skipped) >= maxWalkSkipped {
			res.TooMany = true
			return filepath.SkipAll
		}
		res.Skipped = append(res.Skipped, WalkSkip{r, reason})
		return nil
	}
	err = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if p == base {
			if err != nil {
				return err
			}
			return nil
		}
		r, _ := filepath.Rel(base, p)
		r = filepath.ToSlash(r)
		if err != nil {
			// One unreadable entry or folder does not abort the walk.
			if serr := skip(r, "unreadable"); serr != nil {
				return serr
			}
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		visited++
		if visited > maxWalkEntries {
			res.TooMany = true
			return filepath.SkipAll
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return skip(r, "symlink")
		}
		// A folder is judged by what it would contain (see the root probe above), so a whole
		// ".git" or ".ssh" is skipped as one entry and never entered.
		fullP, realP := path.Join(rel, r), path.Join(real, r)
		_, deniedFull := Denied(fullP)
		_, deniedReal := Denied(realP)
		if d.IsDir() {
			// ...and also by its own name, which a base() rule (credentials.json, *.pem) matches.
			_, f2 := Denied(path.Join(fullP, "x"))
			_, r2 := Denied(path.Join(realP, "x"))
			deniedFull, deniedReal = deniedFull || f2, deniedReal || r2
		}
		if deniedFull || deniedReal {
			if serr := skip(r, "denied"); serr != nil {
				return serr
			}
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return skip(r, "special")
		}
		info, err := d.Info()
		if err != nil {
			return skip(r, "unreadable")
		}
		if add(r, info.Size()) {
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return WalkResult{}, walkErr(rel, err)
	}
	sort.Slice(res.Files, func(i, j int) bool { return res.Files[i].Path < res.Files[j].Path })
	return res, nil
}
