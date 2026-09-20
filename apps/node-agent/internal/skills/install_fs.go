package skills

import (
	"bytes"
	"context"
	"crypto/rand"
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
	"strings"
	"syscall"
	"time"
)

var operationPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var ErrInstallConflict = errors.New("skill installation conflict")
var ErrInstallStoreNotFound = errors.New("managed skill namespace not found")
var ErrInstallOperationNotFound = errors.New("managed skill operation not found")

// InstallStore manages immutable package generations within one station/profile.
// Callers resolve the binding from trusted node identity and station detection,
// never a user-supplied workspace. No method registers or executes a harness.
type InstallStore struct {
	root          *os.Root
	binding       InstallBinding
	directory     string
	workspaceInfo fs.FileInfo
	afterWrite    func(string) error // test-only process-interruption boundary
}

func OpenInstallStore(binding InstallBinding) (*InstallStore, error) {
	return openInstallStore(binding, nil)
}

// OpenExistingInstallStore opens an existing namespace without creating any
// state. Status and verification callers must use this instead of initializing
// a store as a side effect of a read. Missing namespaces return os.ErrNotExist.
func OpenExistingInstallStore(binding InstallBinding) (*InstallStore, error) {
	return openInstallStoreMode(binding, nil, false)
}

func openInstallStore(binding InstallBinding, beforePublish func() error) (*InstallStore, error) {
	return openInstallStoreMode(binding, beforePublish, true)
}

func openInstallStoreMode(binding InstallBinding, beforePublish func() error, create bool) (*InstallStore, error) {
	if binding.NodeID == "" || len(binding.NodeID) > 256 || binding.StationKey == "" || len(binding.StationKey) > 512 || !knownHarness(binding.Harness) || !slugPattern.MatchString(binding.Profile) || len(binding.Profile) > 124 || !filepath.IsAbs(binding.WorkspacePath) {
		return nil, fmt.Errorf("skills: invalid installation binding")
	}
	workspace, err := filepath.EvalSymlinks(binding.WorkspacePath)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(workspace)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("skills: unavailable workspace")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil, fmt.Errorf("skills: unsupported filesystem identity")
	}
	identity := hashBytes([]byte(fmt.Sprintf("%d:%d", stat.Dev, stat.Ino)))
	if binding.WorkspaceIdentity != "" && binding.WorkspaceIdentity != identity {
		return nil, fmt.Errorf("%w: workspace was replaced", ErrInstallConflict)
	}
	binding.WorkspacePath = workspace
	binding.WorkspaceIdentity = identity
	parent, err := os.OpenRoot(workspace)
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	if create {
		if err := makeDirs(parent, ".agentpod-skills"); err != nil {
			return nil, err
		}
		if err := syncDir(parent, "."); err != nil {
			return nil, err
		}
	} else if err := checkComponents(parent, ".agentpod-skills"); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w: %w", ErrInstallStoreNotFound, err)
		}
		return nil, err
	}
	namespace := ".agentpod-skills/" + hashJSON(binding)
	if _, err := parent.Lstat(namespace); errors.Is(err, os.ErrNotExist) {
		if !create {
			return nil, fmt.Errorf("%w: %w", ErrInstallStoreNotFound, err)
		}
		if err := initializeNamespace(parent, namespace, binding, beforePublish); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	if err := checkComponents(parent, namespace); err != nil {
		return nil, err
	}
	root, err := parent.OpenRoot(namespace)
	if err != nil {
		return nil, err
	}
	s := &InstallStore{root: root, binding: binding, directory: filepath.Join(workspace, namespace), workspaceInfo: info}
	var recorded InstallBinding
	if err := s.readJSON("binding.json", &recorded); err != nil || recorded != binding {
		root.Close()
		return nil, fmt.Errorf("%w: unowned or mismatched installation namespace", ErrInstallConflict)
	}
	for _, dir := range []string{"operations", "staging", "generations", "pending"} {
		if err := checkComponents(root, dir); err != nil {
			root.Close()
			return nil, fmt.Errorf("%w: incomplete installation namespace", ErrInstallConflict)
		}
	}
	return s, nil
}

// Publish a complete namespace in one rename. A process exit during initial
// setup leaves an unclaimed temporary directory, not an unrecoverable target.
func initializeNamespace(parent *os.Root, namespace string, binding InstallBinding, beforePublish func() error) error {
	container, err := parent.Open(".agentpod-skills")
	if err != nil {
		return err
	}
	entries, err := container.ReadDir(513)
	container.Close()
	if err != nil && err != io.EOF {
		return err
	}
	if len(entries) > 512 {
		return fmt.Errorf("skills: managed namespace retention limit reached")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := ".agentpod-skills/.init-" + hex.EncodeToString(nonce[:])
	if err := parent.Mkdir(temporary, 0700); err != nil {
		return err
	}
	defer parent.RemoveAll(temporary)
	root, err := parent.OpenRoot(temporary)
	if err != nil {
		return err
	}
	defer root.Close()
	for _, dir := range []string{"operations", "staging", "generations", "pending"} {
		if err := makeDirs(root, dir); err != nil {
			return err
		}
	}
	staged := &InstallStore{root: root, binding: binding}
	if err := staged.atomicWrite("lock", nil, 0600, false); err != nil {
		return err
	}
	if err := staged.writeJSON("binding.json", binding); err != nil {
		return err
	}
	if err := syncDir(root, "."); err != nil {
		return err
	}
	if beforePublish != nil {
		if err := beforePublish(); err != nil {
			return err
		}
	}
	if err := parent.Rename(temporary, namespace); err != nil {
		// Another initializer may have won. Its binding is verified by the caller.
		if !errors.Is(err, syscall.EEXIST) && !errors.Is(err, syscall.ENOTEMPTY) {
			return err
		}
	}
	return syncDir(parent, ".agentpod-skills")
}

func (s *InstallStore) Close() error { return s.root.Close() }
func hashBytes(data []byte) string   { return fmt.Sprintf("%x", sha256.Sum256(data)) }
func hashJSON(value any) string      { data, _ := json.Marshal(value); return hashBytes(data) }

func managedPath(value string) bool {
	if value == "" || len(value) > 4096 || path.IsAbs(value) || path.Clean(value) != value || strings.ContainsAny(value, "\\:") {
		return false
	}
	parts := strings.Split(value, "/")
	if len(parts) > 128 {
		return false
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
	}
	for _, r := range value {
		if r < 32 || r >= 127 {
			return false
		}
	}
	return true
}

func checkComponents(root *os.Root, relative string) error {
	if relative == "." {
		return nil
	}
	if !managedPath(relative) {
		return fmt.Errorf("skills: unsafe managed path")
	}
	name := ""
	for _, part := range strings.Split(relative, "/") {
		name = path.Join(name, part)
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: symbolic link in managed state", ErrInstallConflict)
		}
	}
	return nil
}
func makeDirs(root *os.Root, relative string) error {
	if relative == "." {
		return nil
	}
	if !managedPath(relative) {
		return fmt.Errorf("skills: unsafe managed directory")
	}
	name := ""
	for _, part := range strings.Split(relative, "/") {
		name = path.Join(name, part)
		if err := root.Mkdir(name, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		info, err := root.Lstat(name)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: managed directory is not a directory", ErrInstallConflict)
		}
	}
	return nil
}
func openManaged(root *os.Root, relative string, flags int, mode fs.FileMode) (*os.File, error) {
	if err := checkComponents(root, relative); err != nil {
		if !errors.Is(err, os.ErrNotExist) || flags&os.O_CREATE == 0 {
			return nil, err
		}
		if err := checkComponents(root, path.Dir(relative)); err != nil {
			return nil, err
		}
	}
	file, err := root.OpenFile(relative, flags|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, mode)
	if err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, fmt.Errorf("%w: non-regular managed file", ErrInstallConflict)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); !ok || stat.Nlink != 1 {
		file.Close()
		return nil, fmt.Errorf("%w: linked managed file", ErrInstallConflict)
	}
	return file, nil
}
func readManaged(root *os.Root, relative string, limit int64) ([]byte, error) {
	file, err := openManaged(root, relative, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("skills: managed file exceeds limit")
	}
	return data, nil
}
func syncDir(root *os.Root, relative string) error {
	if err := checkComponents(root, relative); err != nil {
		return err
	}
	dir, err := root.OpenFile(relative, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}
func (s *InstallStore) readJSON(relative string, value any) error {
	data, err := readManaged(s.root, relative, 2<<20)
	if err != nil {
		return err
	}
	unique := json.NewDecoder(bytes.NewReader(data))
	unique.UseNumber()
	if _, err := uniqueJSON(unique, 0); err != nil {
		return err
	}
	if _, err := unique.Token(); err != io.EOF {
		return fmt.Errorf("skills: trailing state data")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}
func (s *InstallStore) writeJSON(relative string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > 2<<20 {
		return fmt.Errorf("skills: operation metadata exceeds limit")
	}
	return s.atomicWrite(relative, data, 0600, false)
}

// Incomplete writes are never published inside a generation. A process crash
// can leave a bounded orphan in pending; it is preserved, not mistaken for a
// user edit to a staged file or silently overwritten during retry.
func (s *InstallStore) atomicWrite(relative string, data []byte, mode fs.FileMode, checkpoints bool) error {
	if err := checkComponents(s.root, "pending"); err != nil {
		return err
	}
	directory, err := s.root.Open("pending")
	if err != nil {
		return err
	}
	entries, err := directory.ReadDir(17)
	directory.Close()
	if err != nil && err != io.EOF {
		return err
	}
	if len(entries) >= 16 {
		return fmt.Errorf("skills: interrupted-write retention limit reached; preserved files require inspection")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := "pending/" + hex.EncodeToString(nonce[:])
	file, err := openManaged(s.root, temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	defer s.root.Remove(temporary)
	defer file.Close()
	if checkpoints {
		if err := s.checkpoint("file-open"); err != nil {
			return err
		}
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if checkpoints {
		if err := s.checkpoint("file-write"); err != nil {
			return err
		}
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := checkComponents(s.root, path.Dir(relative)); err != nil {
		return err
	}
	if err := s.root.Rename(temporary, relative); err != nil {
		return err
	}
	if err := syncDir(s.root, "pending"); err != nil {
		return err
	}
	return syncDir(s.root, path.Dir(relative))
}
func (s *InstallStore) checkIdentity() error {
	current, err := os.Stat(s.binding.WorkspacePath)
	if err != nil || !os.SameFile(current, s.workspaceInfo) {
		return fmt.Errorf("%w: workspace identity changed", ErrInstallConflict)
	}
	resolved, err := filepath.EvalSymlinks(s.binding.WorkspacePath)
	if err != nil || resolved != s.binding.WorkspacePath {
		return fmt.Errorf("%w: workspace path changed", ErrInstallConflict)
	}
	parent, err := os.Lstat(filepath.Dir(s.directory))
	if err != nil || !parent.IsDir() || parent.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: namespace parent changed", ErrInstallConflict)
	}
	actual, err := os.Lstat(s.directory)
	if err != nil || actual.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: namespace path changed", ErrInstallConflict)
	}
	held, err := s.root.Stat(".")
	if err != nil || !os.SameFile(actual, held) {
		return fmt.Errorf("%w: namespace identity changed", ErrInstallConflict)
	}
	return nil
}

func (s *InstallStore) lock(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := s.checkIdentity(); err != nil {
		return nil, err
	}
	file, err := openManaged(s.root, "lock", os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	for {
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			if err := s.checkIdentity(); err != nil {
				syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				file.Close()
				return nil, err
			}
			return func() { syscall.Flock(int(file.Fd()), syscall.LOCK_UN); file.Close() }, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return nil, err
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			file.Close()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
func (s *InstallStore) checkpoint(point string) error {
	if s.afterWrite != nil {
		return s.afterWrite(point)
	}
	return nil
}
