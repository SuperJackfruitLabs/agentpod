//go:build unix

package superbench

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func registeredNode(path string, expected RegisteredNode) error {
	if physicalGroupedDir(path) != nil {
		return ErrRegisteredLayout
	}
	named, err := os.Lstat(path)
	if err != nil {
		return ErrRegisteredLayout
	}
	f, err := groupedOpen(path)
	if err != nil {
		return ErrRegisteredLayout
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !opened.IsDir() || !os.SameFile(named, opened) {
		return ErrRegisteredLayout
	}
	s, ok := opened.Sys().(*syscall.Stat_t)
	if !ok || strconv.FormatUint(uint64(s.Dev), 10) != expected.Device || strconv.FormatUint(s.Ino, 10) != expected.Inode || opened.Mode().Perm() != 0700 || s.Uid != uint32(os.Geteuid()) || s.Gid != uint32(os.Getegid()) {
		return ErrRegisteredLayout
	}
	after, err := os.Lstat(path)
	if err != nil || !os.SameFile(after, opened) || after.Mode() != opened.Mode() {
		return ErrRegisteredLayout
	}
	return nil
}

// Checks are observations under the payload identity. The installed producer
// must verify its durable layout and current owner before starting this worker;
// a self-supplied capsule can never establish that authority.
func inspectRegistered(ctx context.Context, c RegisteredCapsule) error {
	root := c.Task.WorkspaceRoot
	l := c.Layout
	nodes := map[string]RegisteredNode{root: l.Root, filepath.Join(root, ".superbench-runtime", ".root", "home"): l.RootHome, filepath.Join(root, ".superbench-runtime", ".root", "tmp"): l.RootTemp}
	for i, m := range c.Task.Members {
		n := l.Members[i]
		nodes[filepath.Join(root, m.Name)] = n.Checkout
		nodes[filepath.Join(root, ".superbench-git", m.Name)] = n.Admin
		nodes[filepath.Join(root, ".superbench-runtime", m.Name, "home")] = n.Home
		nodes[filepath.Join(root, ".superbench-runtime", m.Name, "tmp")] = n.Temp
	}
	checkNodes := func() error {
		for p, n := range nodes {
			if err := registeredNode(p, n); err != nil {
				return err
			}
		}
		return nil
	}
	if err := checkNodes(); err != nil {
		return err
	}
	entries, err := os.ReadDir(root)
	allowed := map[string]bool{".superbench-git": true, ".superbench-runtime": true}
	for _, m := range c.Task.Members {
		allowed[m.Name] = true
	}
	if err != nil || len(entries) != len(allowed) {
		return ErrRegisteredLayout
	}
	for _, e := range entries {
		if !allowed[e.Name()] || !e.IsDir() || e.Type()&os.ModeSymlink != 0 {
			return ErrRegisteredLayout
		}
	}
	for _, m := range c.Task.Members {
		if err := inspectRegisteredMember(ctx, root, m); err != nil {
			return err
		}
	}
	return checkNodes()
}
func inspectRegisteredMember(ctx context.Context, root string, m GroupedMember) error {
	checkout := filepath.Join(root, m.Name)
	admin := filepath.Join(root, ".superbench-git", m.Name)
	raw, err := groupedRegular(filepath.Join(checkout, ".git"), 4096)
	if err != nil || string(raw) != "gitdir: "+admin+"\n" {
		return ErrRegisteredLayout
	}
	// Private independent admins have no shared commondir or external objects.
	for _, p := range []string{"commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"} {
		if !groupedAbsent(filepath.Join(admin, p)) {
			return ErrRegisteredLayout
		}
	}
	for _, p := range []string{"objects", "refs"} {
		if physicalGroupedDir(filepath.Join(admin, p)) != nil {
			return ErrRegisteredLayout
		}
	}
	if _, err = groupedRegular(filepath.Join(admin, "HEAD"), 4096); err != nil {
		return ErrRegisteredLayout
	}
	index, err := os.Lstat(filepath.Join(admin, "index"))
	if err != nil || !index.Mode().IsRegular() {
		return ErrRegisteredLayout
	}
	if groupedConfig(ctx, root, filepath.Join(admin, "config"), false) != nil || groupedConfig(ctx, root, filepath.Join(admin, "config.worktree"), true) != nil {
		return ErrRegisteredLayout
	}
	check := func(want string, args ...string) bool {
		out, e := groupedGit(ctx, checkout, args...)
		return e == nil && strings.TrimSuffix(out, "\n") == want
	}
	if !check(checkout, "rev-parse", "--show-toplevel") || !check(admin, "rev-parse", "--path-format=absolute", "--git-common-dir") || !check("false", "rev-parse", "--is-bare-repository") || !check(m.TaskRef, "symbolic-ref", "--quiet", "HEAD") || !check(m.ObjectFormat, "rev-parse", "--show-object-format=storage") || !check(m.Commit, "rev-parse", "--verify", "HEAD^{commit}") || !check("", "for-each-ref", "--format=%(refname)", "refs/replace/") {
		return ErrRegisteredLayout
	}
	origin, err := groupedGit(ctx, checkout, "config", "--null", "--get-all", "remote.origin.url")
	if err != nil || !strings.HasSuffix(origin, "\x00") || strings.Count(origin, "\x00") != 1 || strings.ContainsAny(origin, "\r\n") || groupedSHA([]byte(strings.TrimSuffix(origin, "\x00"))) != m.RepositorySHA256 {
		return ErrRegisteredLayout
	}
	flags, err := groupedGit(ctx, checkout, "ls-files", "-v", "-z")
	if err != nil {
		return ErrRegisteredLayout
	}
	for _, line := range strings.Split(flags, "\x00") {
		if line != "" && !strings.HasPrefix(line, "H ") {
			return ErrRegisteredLayout
		}
	}
	staged, err := groupedGit(ctx, checkout, "ls-files", "--stage", "-z")
	if err != nil {
		return ErrRegisteredLayout
	}
	for _, line := range strings.Split(staged, "\x00") {
		if strings.HasPrefix(line, "160000 ") {
			return ErrRegisteredLayout
		}
	}
	if !check("", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all") {
		return ErrRegisteredLayout
	}
	return nil
}
