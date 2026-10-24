//go:build linux

package stationfs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const maxEntries = 120000
const maxFiles = 100000
const maxFileBytes = 256 * 1024
const maxSnapshotBytes = 512 * 1024 * 1024

var safeID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var refused = errors.New("station filesystem boundary refused")

type entry struct {
	Path  string        `json:"path"`
	Dev   uint64        `json:"dev"`
	Inode uint64        `json:"inode"`
	Size  int64         `json:"bytes"`
	Mode  uint32        `json:"mode"`
	Mtime unix.Timespec `json:"mtime"`
	Ctime unix.Timespec `json:"ctime"`
}
type root struct {
	fd   int
	stat unix.Stat_t
	path string
}

func excluded(name string) bool {
	lower := strings.ToLower(name)
	for _, n := range []string{".git", ".state", ".ssh", ".aws", ".azure", ".config", ".npmrc", ".netrc", "credentials", ".salaam", "node_modules", ".venv", ".cache", ".pi", ".claude", ".codex", ".hermes", ".openclaw", ".local"} {
		if lower == n || strings.HasPrefix(lower, n+".") {
			return true
		}
	}
	return strings.HasPrefix(lower, ".env") || strings.HasPrefix(lower, ".salaam-station-") || strings.HasSuffix(lower, ".pem") || strings.HasSuffix(lower, ".key")
}
func relative(p string) bool {
	if !utf8.ValidString(p) || p == "" || len(p) > 512 || path.Clean(p) != p || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.ContainsAny(p, "\x00\r\n") || strings.Count(p, "/") > 31 {
		return false
	}
	for _, name := range strings.Split(p, "/") {
		if name == ".." || name == "." || excluded(name) {
			return false
		}
		for _, r := range name {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}
func openRoot(p string) (*root, error) {
	actual, err := filepath.EvalSymlinks(p)
	if err != nil || !filepath.IsAbs(p) || filepath.Clean(p) != p || actual != p || p == "/" {
		return nil, refused
	}
	fd, err := unix.Open(p, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	r := &root{fd: fd, path: p}
	if err = unix.Fstat(fd, &r.stat); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return r, nil
}
func (r *root) unchanged() error {
	var st unix.Stat_t
	if unix.Lstat(r.path, &st) != nil || st.Dev != r.stat.Dev || st.Ino != r.stat.Ino || st.Mode&unix.S_IFMT != unix.S_IFDIR {
		return refused
	}
	return nil
}
func (r *root) open(p string, flags int) (int, error) {
	// openat2 rejects flags outside O_PATH's closed set (unlike legacy open).
	if flags&unix.O_PATH == 0 {
		flags |= unix.O_NONBLOCK
	}
	return unix.Openat2(r.fd, p, &unix.OpenHow{Flags: uint64(flags | unix.O_NOFOLLOW | unix.O_CLOEXEC), Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_MAGICLINKS | unix.RESOLVE_NO_XDEV})
}
func (r *root) index() ([]entry, string, error) {
	files, _, digest, err := r.indexAll()
	return files, digest, err
}

// dirEntry is a directory as the tree digest sees it. Times are left out on purpose: staging a
// file inside a directory changes its mtime, and the digest must not move for that.
type dirEntry struct {
	Path  string `json:"path"`
	Dev   uint64 `json:"dev"`
	Inode uint64 `json:"inode"`
	Mode  uint32 `json:"dir_mode"`
}

func (r *root) indexAll() ([]entry, []dirEntry, string, error) {
	result := make([]entry, 0)
	dirs := make([]dirEntry, 0)
	count := 0
	var walk func(string, int) error
	walk = func(base string, depth int) error {
		if depth > 32 {
			return refused
		}
		fd, err := r.open(base, unix.O_RDONLY|unix.O_DIRECTORY)
		if err != nil {
			return err
		}
		f := os.NewFile(uintptr(fd), base)
		names, err := f.Readdirnames(maxEntries + 1)
		f.Close()
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		sort.Strings(names)
		for _, name := range names {
			count++
			if count > maxEntries {
				return refused
			}
			if excluded(name) {
				continue
			}
			p := name
			if base != "." {
				p = base + "/" + name
			}
			if !relative(p) {
				return refused
			}
			fd, err := r.open(p, unix.O_PATH)
			if err != nil {
				return err
			}
			var st unix.Stat_t
			err = unix.Fstat(fd, &st)
			unix.Close(fd)
			if err != nil || st.Dev != r.stat.Dev {
				return refused
			}
			switch st.Mode & unix.S_IFMT {
			case unix.S_IFDIR:
				dirs = append(dirs, dirEntry{p, st.Dev, st.Ino, st.Mode & 0777})
				if err := walk(p, depth+1); err != nil {
					return err
				}
			case unix.S_IFREG:
				if st.Nlink != 1 || st.Size < 0 || st.Size > maxSnapshotBytes || len(result) >= maxFiles {
					return refused
				}
				result = append(result, entry{p, st.Dev, st.Ino, st.Size, st.Mode & 0777, st.Mtim, st.Ctim})
			default:
				return refused
			}
		}
		return nil
	}
	if err := walk(".", 0); err != nil {
		return nil, nil, "", err
	}
	if err := r.unchanged(); err != nil {
		return nil, nil, "", err
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Path < dirs[j].Path })
	data, _ := json.Marshal(struct {
		Files []entry    `json:"files"`
		Dirs  []dirEntry `json:"dirs"`
	}{result, dirs})
	sum := sha256.Sum256(data)
	return result, dirs, hex.EncodeToString(sum[:]), nil
}
func stable(a, b unix.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Size == b.Size && a.Mode == b.Mode && a.Nlink == b.Nlink && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}
func hash(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func (r *root) read(p string, limit int64) ([]byte, unix.Stat_t, error) {
	var before, after unix.Stat_t
	if !relative(p) {
		return nil, before, refused
	}
	fd, err := r.open(p, unix.O_RDONLY)
	if err != nil {
		return nil, before, err
	}
	f := os.NewFile(uintptr(fd), p)
	defer f.Close()
	if unix.Fstat(fd, &before) != nil || before.Mode&unix.S_IFMT != unix.S_IFREG || before.Nlink != 1 || before.Size > limit {
		return nil, before, refused
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(data)) > limit || unix.Fstat(fd, &after) != nil || !stable(before, after) {
		return nil, before, refused
	}
	return data, before, nil
}
func execute(q Request) (any, error) {
	runtime.LockOSThread()
	parent := os.Getppid()
	if parent <= 1 || unix.Prctl(unix.PR_SET_PDEATHSIG, uintptr(unix.SIGKILL), 0, 0, 0) != nil || os.Getppid() != parent {
		return nil, refused
	}

	r, err := openRoot(q.Root)
	if err != nil {
		return nil, err
	}
	defer unix.Close(r.fd)
	if q.RootIdentity != hash([]byte(fmt.Sprintf(`{"dev":"%d","inode":"%d"}`, r.stat.Dev, r.stat.Ino))) {
		return nil, refused
	}
	entries, tree, err := r.index()
	if err != nil {
		return nil, err
	}
	if q.ExpectedTree != "" && tree != q.ExpectedTree {
		return nil, refused
	}
	result := map[string]any{"version": 1, "ok": true, "tree_digest": tree, "files": len(entries), "root_identity": q.RootIdentity}
	switch q.Action {
	case "inspect":
	case "list", "search":
		if q.Action == "search" {
			if q.Query == "" || len(q.Query) > 256 || !utf8.ValidString(q.Query) {
				return nil, refused
			}
			filtered := make([]entry, 0)
			for _, e := range entries {
				if strings.Contains(e.Path, q.Query) {
					filtered = append(filtered, e)
				}
			}
			entries = filtered
		}
		if q.Offset < 0 || q.Offset > len(entries) {
			return nil, refused
		}
		end := q.Offset + 40
		if end > len(entries) {
			end = len(entries)
		}
		result["entries"] = entries[q.Offset:end]
		result["next_offset"] = nil
		if end < len(entries) {
			result["next_offset"] = end
		}
	case "read":
		data, _, err := r.read(q.Path, maxFileBytes)
		if err != nil || !utf8.Valid(data) || strings.ContainsRune(string(data), 0) {
			return nil, refused
		}
		result["path"] = q.Path
		result["content"] = string(data)
		result["sha256"] = hash(data)
	case "snapshot":
		if q.ExpectedTree == "" || !safeID.MatchString(q.RequestID) || !filepath.IsAbs(q.Snapshot) || filepath.Clean(q.Snapshot) != q.Snapshot || q.Snapshot == q.Root || strings.HasPrefix(q.Snapshot, q.Root+"/") {
			return nil, refused
		}
		if err := os.Mkdir(q.Snapshot, 0700); err != nil {
			return nil, err
		}
		complete := false
		defer func() {
			if !complete {
				_ = os.RemoveAll(q.Snapshot)
			}
		}()
		var total int64
		for _, e := range entries {
			total += e.Size
			if total > maxSnapshotBytes {
				return nil, refused
			}
			fd, err := r.open(e.Path, unix.O_RDONLY)
			if err != nil {
				return nil, err
			}
			source := os.NewFile(uintptr(fd), e.Path)
			var st, after unix.Stat_t
			if unix.Fstat(fd, &st) != nil || st.Mode&unix.S_IFMT != unix.S_IFREG || st.Nlink != 1 || st.Ino != e.Inode || st.Dev != e.Dev || st.Mtim != e.Mtime || st.Ctim != e.Ctime || st.Size != e.Size {
				source.Close()
				return nil, refused
			}
			p := filepath.Join(q.Snapshot, filepath.FromSlash(e.Path))
			if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
				source.Close()
				return nil, err
			}
			mode := fs.FileMode(0444)
			if e.Mode&0111 != 0 {
				mode = 0555
			}
			destination, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
			if err != nil {
				source.Close()
				return nil, err
			}
			copied, err := io.Copy(destination, io.LimitReader(source, e.Size+1))
			statErr := unix.Fstat(fd, &after)
			source.Close()
			modeErr := destination.Chmod(mode)
			closeErr := destination.Close()
			if err != nil || statErr != nil || modeErr != nil || closeErr != nil || copied != e.Size || !stable(st, after) {
				return nil, refused
			}
		}
		_, now, err := r.index()
		if err != nil || now != tree {
			return nil, refused
		}
		if err := filepath.WalkDir(q.Snapshot, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				return os.Chmod(p, 0555)
			}
			return nil
		}); err != nil {
			return nil, err
		}
		complete = true
		result["snapshot"] = q.Snapshot
		result["bytes"] = total
	case "patch":
		if err := r.patch(q, tree); err != nil {
			return nil, err
		}
		_, after, err := r.index()
		if err != nil {
			return nil, err
		}
		result["before_tree_digest"] = tree
		result["tree_digest"] = after
		result["path"] = q.Path
		if q.createdDirs != nil && len(*q.createdDirs) > 0 {
			result["created_directories"] = *q.createdDirs
		}
		result["sha256"] = nil
		if q.Content != nil {
			actual, _, err := r.read(q.Path, maxFileBytes)
			if err != nil || hash(actual) != hash([]byte(*q.Content)) {
				return nil, refused
			}
			result["sha256"] = hash(actual)
		} else {
			fd, err := r.open(q.Path, unix.O_PATH)
			if err == nil {
				unix.Close(fd)
				return nil, refused
			}
			if !errors.Is(err, unix.ENOENT) {
				return nil, refused
			}
		}
	default:
		return nil, refused
	}
	return result, nil
}
func (r *root) patch(q Request, tree string) error {
	deadline := q.deadline
	if deadline.IsZero() || time.Now().After(deadline) {
		return refused
	}
	if !relative(q.Path) || !safeID.MatchString(q.RequestID) || q.ExpectedTree == "" || (q.ExpectedHash == nil && q.Content == nil) || (q.Content != nil && (len(*q.Content) > maxFileBytes || !utf8.ValidString(*q.Content) || strings.ContainsRune(*q.Content, 0))) {
		return refused
	}
	parent, leaf := path.Split(q.Path)
	parent = strings.TrimSuffix(parent, "/")
	if parent == "" {
		parent = "."
	}
	fd, err := r.open(parent, unix.O_RDONLY|unix.O_DIRECTORY)
	if errors.Is(err, unix.ENOENT) && q.ExpectedHash == nil {
		// A new file may need its directories. They are created one at a time beneath the root
		// (openat2 RESOLVE_BENEATH, no symlinks), 0700 like a new file's 0600, and only after the
		// reviewed tree is confirmed; the digest must then differ by exactly those directories.
		var created []string
		if created, tree, err = r.parents(q, parent, tree); err != nil {
			return err
		}
		if q.createdDirs != nil {
			*q.createdDirs = created
		}
		fd, err = r.open(parent, unix.O_RDONLY|unix.O_DIRECTORY)
	}
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	mode := uint32(0600)
	var original unix.Stat_t
	if q.ExpectedHash != nil {
		data, st, err := r.read(q.Path, maxFileBytes)
		if err != nil || hash(data) != *q.ExpectedHash {
			return refused
		}
		original = st
		mode = st.Mode & 0777
	} else {
		var st unix.Stat_t
		if err := unix.Fstatat(fd, leaf, &st, unix.AT_SYMLINK_NOFOLLOW); !errors.Is(err, unix.ENOENT) {
			return refused
		}
	}
	stage := ".salaam-station-" + q.RequestID
	f, err := unix.Openat(fd, stage, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode)
	if err != nil {
		return err
	}
	var stagedStat unix.Stat_t
	if unix.Fstat(f, &stagedStat) != nil {
		unix.Close(f)
		return refused
	}
	staged := os.NewFile(uintptr(f), stage)
	if q.Content != nil {
		_, err = staged.WriteString(*q.Content)
	}
	if err == nil {
		err = staged.Sync()
	}
	closeErr := staged.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	// The source is never mounted writable into a command. The metadata and exact
	// file bytes are rechecked immediately before the atomic namespace operation.
	_, now, err := r.index()
	if err != nil || now != tree {
		_ = unix.Unlinkat(fd, stage, 0)
		return refused
	}
	if time.Now().After(deadline) || time.Now().UnixMilli() >= q.DeadlineMs {
		return refused
	}
	if q.ExpectedHash == nil {
		if q.effectPossible != nil {
			*q.effectPossible = true
		}
		err = unix.Renameat2(fd, stage, fd, leaf, unix.RENAME_NOREPLACE)
	} else {
		var current unix.Stat_t
		if unix.Fstatat(fd, leaf, &current, unix.AT_SYMLINK_NOFOLLOW) != nil || !stable(current, original) {
			_ = unix.Unlinkat(fd, stage, 0)
			return refused
		}
		if q.effectPossible != nil {
			*q.effectPossible = true
		}
		err = unix.Renameat2(fd, stage, fd, leaf, unix.RENAME_EXCHANGE)
		if err == nil {
			var displaced unix.Stat_t
			if unix.Fstatat(fd, stage, &displaced, unix.AT_SYMLINK_NOFOLLOW) != nil || displaced.Ino != original.Ino || displaced.Dev != original.Dev {
				// Preserve both files if an uncooperative host writer raced the
				// exchange. Never blindly replay, discard or overwrite its bytes.
				return refused
			}
			if q.Content == nil {
				captured := stage + "-delete"
				err = unix.Renameat2(fd, leaf, fd, captured, unix.RENAME_NOREPLACE)
				if err == nil {
					var removed unix.Stat_t
					if unix.Fstatat(fd, captured, &removed, unix.AT_SYMLINK_NOFOLLOW) != nil || removed.Ino != stagedStat.Ino || removed.Dev != stagedStat.Dev {
						return refused
					}
					err = unix.Unlinkat(fd, captured, 0)
				}
			}
			if err == nil {
				err = unix.Unlinkat(fd, stage, 0)
			}
		}
	}
	if err != nil {
		return fmt.Errorf("station patch: %w", err)
	}
	if err = unix.Fsync(fd); err != nil {
		return err
	}
	return r.unchanged()
}

// parents creates the missing directories of parent, beneath the root only, and returns them with
// the tree digest that now includes them. Nothing is created unless the tree still equals the
// reviewed tree, and the new tree must differ from it by exactly the created directories.
func (r *root) parents(q Request, parent, tree string) ([]string, string, error) {
	files0, dirs0, now, err := r.indexAll()
	if err != nil || now != tree {
		return nil, "", refused
	}
	var created []string
	undo := func() {
		for i := len(created) - 1; i >= 0; i-- {
			_ = unix.Unlinkat(r.fd, created[i], unix.AT_REMOVEDIR)
		}
	}
	prefix := ""
	for _, name := range strings.Split(parent, "/") {
		next := name
		if prefix != "" {
			next = prefix + "/" + name
		}
		fd, err := r.open(next, unix.O_RDONLY|unix.O_DIRECTORY)
		if err == nil {
			unix.Close(fd)
			prefix = next
			continue
		}
		// Missing or not: mkdirat refuses a symlink or a file in the way (EEXIST), and openat2
		// refused to resolve through either, so nothing below is ever reached through a link.
		base := "."
		if prefix != "" {
			base = prefix
		}
		bfd, err := r.open(base, unix.O_RDONLY|unix.O_DIRECTORY)
		if err != nil {
			undo()
			return nil, "", refused
		}
		if q.effectPossible != nil {
			*q.effectPossible = true
		}
		beforeMkdir()
		err = unix.Mkdirat(bfd, name, 0700)
		unix.Close(bfd)
		if err != nil {
			undo()
			return nil, "", refused
		}
		created = append(created, next)
		prefix = next
	}
	files1, dirs1, after, err := r.indexAll()
	if err != nil || !sameFiles(files0, files1) || !addedOnly(dirs0, dirs1, created) {
		undo()
		return nil, "", refused
	}
	return created, after, nil
}

func sameFiles(a, b []entry) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

// addedOnly holds when after is before plus exactly the created directories.
func addedOnly(before, after []dirEntry, created []string) bool {
	if len(after) != len(before)+len(created) {
		return false
	}
	seen := map[string]dirEntry{}
	for _, d := range after {
		seen[d.Path] = d
	}
	for _, d := range before {
		if seen[d.Path] != d {
			return false
		}
		delete(seen, d.Path)
	}
	for _, c := range created {
		d, ok := seen[c]
		if !ok || d.Mode != 0700 {
			return false
		}
		delete(seen, c)
	}
	return len(seen) == 0
}

// beforeMkdir lets a test change the tree between the reviewed check and a directory creation.
var beforeMkdir = func() {}
