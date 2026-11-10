package descriptor

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/fsops"
)

// The guarded file paths. fs.read (whole file or offset), fs.list and fs.walk all serve a
// station's files to anyone in its workspace, so all of them go through the same checks: the
// path inside the root, the denylist (Denied) and the harness-private names (HarnessPrivate),
// each applied to the requested path and again to where it really resolves, and the open made
// through os.Root. A descriptor's own ReadFile and ListDir are not used for them: they join
// lexically and follow symlinks, which is how a member could read a station's .env.

// ErrNoWorkspaceRoot marks a descriptor that names no workspace root, so it has nothing the
// guarded reads can serve.
var ErrNoWorkspaceRoot = errors.New("no workspace root")

// MaxWholeRead caps one whole-file read: the hub's own ceiling on a console read (8 MiB).
const MaxWholeRead = 8 << 20

// defaultWholeRead is what a whole-file read returns when the caller names no size.
const defaultWholeRead = 1 << 20

// guardedRoot is the station's workspace root and harness-private names.
func guardedRoot(d Descriptor, key string) (string, []string, error) {
	rooter, ok := d.(WorkspaceRooter)
	if !ok {
		return "", nil, fmt.Errorf("%w: %s", ErrNoWorkspaceRoot, key)
	}
	root, err := rooter.WorkspaceRoot(key)
	if err != nil {
		// A descriptor's own error may name host paths; the hub gets the key only.
		return "", nil, fmt.Errorf("no workspace for %s", key)
	}
	return root, privateOf(d, key), nil
}

// GuardedReadFile reads up to max bytes from the start of rel in the station's workspace, with
// ReadAt's checks. It reports whether the file goes on past what was read.
func GuardedReadFile(d Descriptor, key, rel string, max int64) ([]byte, bool, error) {
	root, private, err := guardedRoot(d, key)
	if err != nil {
		return nil, false, err
	}
	if max <= 0 {
		max = defaultWholeRead
	}
	b, _, eof, err := readAt(root, rel, 0, max, MaxWholeRead, private)
	if err != nil {
		return nil, false, PathErr(rel, "read", err)
	}
	return b, !eof, nil
}

// GuardedListDir lists the folder rel in the station's workspace. A denied or harness-private
// folder is refused, and denied or private entries are left out of the listing.
func GuardedListDir(d Descriptor, key, rel string) ([]FsEntry, error) {
	root, private, err := guardedRoot(d, key)
	if err != nil {
		return nil, err
	}
	if rel == "" {
		rel = "."
	}
	entries, err := listDir(root, rel, private)
	if err != nil {
		return nil, PathErr(rel, "list", err)
	}
	return entries, nil
}

// deniedFolder reports the rule a folder at p breaks: its own name, or what it would contain
// (".ssh" and ".git" are denied as folders, which Denied only sees from a path beneath them).
func deniedFolder(p string) (string, bool) {
	if rule, ok := Denied(p); ok {
		return rule, true
	}
	return Denied(path.Join(p, "x"))
}

func listDir(root, rel string, private []string) ([]FsEntry, error) {
	if rule, ok := deniedFolder(rel); ok {
		return nil, fmt.Errorf("%w: %s (%s)", ErrDenied, rel, rule)
	}
	if rel != "." && PrivateHit(rel, private) {
		return nil, fmt.Errorf("%w: %s (harness-private)", ErrDenied, rel)
	}
	target, err := fsops.Jail(root, rel)
	if err != nil {
		return nil, err
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return nil, err
	}
	real, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || real == ".." || strings.HasPrefix(real, ".."+string(filepath.Separator)) {
		return nil, fsops.ErrEscape
	}
	real = filepath.ToSlash(real)
	if rule, ok := deniedFolder(real); ok {
		return nil, fmt.Errorf("%w: %s resolves to %s (%s)", ErrDenied, rel, real, rule)
	}
	if real != "." && PrivateHit(real, private) {
		return nil, fmt.Errorf("%w: %s resolves to %s (harness-private)", ErrDenied, rel, real)
	}
	// Open through os.Root so a folder swapped for a symlink after the checks above cannot lead
	// out of the root.
	r, err := os.OpenRoot(resolvedRoot)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	dir, err := r.Open(real)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	des, err := dir.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	// In name order, as os.ReadDir gives (a File's ReadDir is in directory order).
	sort.Slice(des, func(i, j int) bool { return des[i].Name() < des[j].Name() })
	shown := filepath.ToSlash(filepath.Clean(rel))
	out := make([]FsEntry, 0, len(des))
	for _, de := range des {
		p, realP := path.Join(shown, de.Name()), path.Join(real, de.Name())
		_, deniedP := Denied(p)
		_, deniedReal := Denied(realP)
		if de.IsDir() {
			_, d1 := deniedFolder(p)
			_, d2 := deniedFolder(realP)
			deniedP, deniedReal = deniedP || d1, deniedReal || d2
		}
		if deniedP || deniedReal || PrivateHit(p, private) || PrivateHit(realP, private) {
			continue
		}
		e := FsEntry{Name: de.Name(), Path: p}
		switch {
		case de.Type()&os.ModeSymlink != 0:
			e.Type = "symlink"
		case de.IsDir():
			e.Type = "dir"
		default:
			e.Type = "file"
			// An entry the node cannot stat is still listed, just without size and time.
			if info, err := de.Info(); err == nil {
				size := info.Size()
				mod := info.ModTime().UTC().Format(time.RFC3339)
				e.Size, e.Modified = &size, &mod
			}
		}
		out = append(out, e)
	}
	return out, nil
}
