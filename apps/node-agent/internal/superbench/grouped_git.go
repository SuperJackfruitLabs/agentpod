package superbench

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// File inventories are larger than the private 64KiB context/result envelope.
// Retain at most 4MiB per observation; overflow always refuses admission.
type groupedGitCapture struct {
	bytes.Buffer
	overflow bool
}

func (b *groupedGitCapture) Write(p []byte) (int, error) {
	n := len(p)
	remaining := (4 << 20) - b.Len()
	if len(p) > remaining {
		b.overflow = true
		p = p[:remaining]
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

// Git is a fixed host tool, not PATH, a shell wrapper, repository alias, or a
// spec-selected executable. No network/transport commands are used here.
func groupedGit(ctx context.Context, dir string, args ...string) (string, error) {
	policy := []string{"--no-optional-locks", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.ignoreStat=false", "-C", dir}
	cmd := exec.CommandContext(ctx, "/usr/bin/git", append(policy, args...)...)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0", "GIT_NO_LAZY_FETCH=1"}
	cmd.WaitDelay = 2 * time.Second
	out := &groupedGitCapture{}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	e := cmd.Run()
	raw, overflow := out.Bytes(), out.overflow
	if e != nil || overflow {
		return "", errGrouped
	}
	return string(raw), nil
}
func groupedRegular(path string, limit int64) ([]byte, error) {
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errGrouped
	}
	f, e := groupedOpen(path)
	if e != nil {
		return nil, errGrouped
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, errGrouped
	}
	raw, e := io.ReadAll(io.LimitReader(f, limit+1))
	if e != nil || int64(len(raw)) > limit {
		return nil, errGrouped
	}
	after, e := os.Lstat(path)
	if e != nil || !after.Mode().IsRegular() || !os.SameFile(info, after) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
		return nil, errGrouped
	}
	return raw, nil
}
func groupedAbsent(path string) bool { _, e := os.Lstat(path); return os.IsNotExist(e) }
func groupedConfig(ctx context.Context, contextDir, path string, optional bool) error {
	if optional && groupedAbsent(path) {
		return nil
	}
	if _, e := groupedRegular(path, MaxWorker); e != nil {
		return errGrouped
	}
	// Inspect only this fixed file, not a repository's include graph. Includes
	// and filters are refused before status could load external clean helpers.
	out, e := groupedGit(ctx, contextDir, "config", "--file", path, "--no-includes", "--null", "--list")
	if e != nil {
		return errGrouped
	}
	for _, entry := range strings.Split(out, "\x00") {
		key, _, _ := strings.Cut(entry, "\n")
		key = strings.ToLower(key)
		if strings.HasPrefix(key, "include.") || strings.HasPrefix(key, "includeif.") || strings.HasPrefix(key, "filter.") || key == "core.worktree" || key == "core.attributesfile" || key == "core.excludesfile" || key == "extensions.partialclone" || strings.HasSuffix(key, ".promisor") || strings.HasSuffix(key, ".partialclonefilter") {
			return errGrouped
		}
	}
	return nil
}
func groupedPathLine(raw []byte) (string, error) {
	text := strings.TrimSuffix(string(raw), "\n")
	if text == "" || strings.ContainsAny(text, "\x00\r\n") {
		return "", errGrouped
	}
	return text, nil
}
func inspectGrouped(ctx context.Context, contextDir string, s GroupedWorkerSpec) error {
	if physicalGroupedDir(s.WorkspaceRoot) != nil {
		return errGrouped
	}
	data := filepath.Dir(filepath.Dir(s.WorkspaceRoot))
	mirrors := filepath.Join(data, "mirrors")
	for _, p := range []string{data, filepath.Dir(s.WorkspaceRoot), mirrors} {
		if physicalGroupedDir(p) != nil {
			return errGrouped
		}
	}
	entries, e := os.ReadDir(s.WorkspaceRoot)
	if e != nil || len(entries) != len(s.Members) {
		return errGrouped
	}
	for i, entry := range entries {
		if entry.Name() != s.Members[i].Name || !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return errGrouped
		}
	}
	for _, member := range s.Members {
		if inspectGroupedMember(ctx, contextDir, s.WorkspaceRoot, mirrors, member) != nil {
			return errGrouped
		}
	}
	return nil
}
func inspectGroupedMember(ctx context.Context, contextDir, root, mirrors string, m GroupedMember) error {
	path := filepath.Join(root, m.Name)
	mirror := filepath.Join(mirrors, m.RepositorySHA256+".git")
	for _, p := range []string{path, mirror, filepath.Join(mirror, "worktrees"), filepath.Join(mirror, "objects")} {
		if physicalGroupedDir(p) != nil {
			return errGrouped
		}
	}
	pointer, e := groupedRegular(filepath.Join(path, ".git"), 4096)
	if e != nil {
		return errGrouped
	}
	line, e := groupedPathLine(pointer)
	if e != nil || !strings.HasPrefix(line, "gitdir: ") {
		return errGrouped
	}
	admin := strings.TrimPrefix(line, "gitdir: ")
	if filepath.Dir(admin) != filepath.Join(mirror, "worktrees") || physicalGroupedDir(admin) != nil {
		return errGrouped
	}
	commonRaw, e := groupedRegular(filepath.Join(admin, "commondir"), 4096)
	if e != nil {
		return errGrouped
	}
	common, e := groupedPathLine(commonRaw)
	if e != nil {
		return errGrouped
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(admin, common)
	}
	if filepath.Clean(common) != mirror {
		return errGrouped
	}
	backRaw, e := groupedRegular(filepath.Join(admin, "gitdir"), 4096)
	if e != nil {
		return errGrouped
	}
	back, e := groupedPathLine(backRaw)
	if e != nil || back != filepath.Join(path, ".git") {
		return errGrouped
	}
	if _, e = groupedRegular(filepath.Join(admin, "HEAD"), 4096); e != nil {
		return errGrouped
	}
	// Index bytes may be large; identity/type is checked without reading them.
	index, e := os.Lstat(filepath.Join(admin, "index"))
	if e != nil || !index.Mode().IsRegular() {
		return errGrouped
	}
	for _, folder := range []string{"objects/info", "objects/pack"} {
		candidate := filepath.Join(mirror, folder)
		if !groupedAbsent(candidate) && physicalGroupedDir(candidate) != nil {
			return errGrouped
		}
	}
	for _, file := range []string{"alternates", "http-alternates"} {
		if !groupedAbsent(filepath.Join(mirror, "objects", "info", file)) {
			return errGrouped
		}
	}
	if groupedConfig(ctx, contextDir, filepath.Join(mirror, "config"), false) != nil || groupedConfig(ctx, contextDir, filepath.Join(admin, "config.worktree"), true) != nil {
		return errGrouped
	}
	check := func(want string, args ...string) bool {
		out, e := groupedGit(ctx, path, args...)
		return e == nil && strings.TrimSuffix(out, "\n") == want
	}
	if !check(path, "rev-parse", "--show-toplevel") || !check(mirror, "rev-parse", "--path-format=absolute", "--git-common-dir") || !check(m.TaskRef, "symbolic-ref", "--quiet", "HEAD") || !check(m.ObjectFormat, "rev-parse", "--show-object-format=storage") || !check(m.Commit, "rev-parse", "--verify", "HEAD^{commit}") {
		return errGrouped
	}
	bare, e := groupedGit(ctx, mirror, "rev-parse", "--is-bare-repository")
	if e != nil || bare != "true\n" {
		return errGrouped
	}
	origin, e := groupedGit(ctx, path, "config", "--null", "--get-all", "remote.origin.url")
	if e != nil || !strings.HasSuffix(origin, "\x00") || strings.Count(origin, "\x00") != 1 || len(origin) == 1 || strings.ContainsAny(origin, "\r\n") || groupedSHA([]byte(strings.TrimSuffix(origin, "\x00"))) != m.RepositorySHA256 {
		return errGrouped
	}
	mirrorOrigin, e := groupedGit(ctx, mirror, "config", "--null", "--get-all", "remote.origin.url")
	if e != nil || mirrorOrigin != origin {
		return errGrouped
	}
	if !check("", "for-each-ref", "--format=%(refname)", "refs/replace/") {
		return errGrouped
	}
	flags, e := groupedGit(ctx, path, "ls-files", "-v", "-z")
	if e != nil {
		return errGrouped
	}
	for _, entry := range strings.Split(flags, "\x00") {
		if entry != "" && !strings.HasPrefix(entry, "H ") {
			return errGrouped
		}
	}
	// Submodule state is outside this complete registered repository vector.
	// Refuse it before status; do not inspect an unapproved nested Git config.
	staged, e := groupedGit(ctx, path, "ls-files", "--stage", "-z")
	if e != nil {
		return errGrouped
	}
	for _, entry := range strings.Split(staged, "\x00") {
		if strings.HasPrefix(entry, "160000 ") {
			return errGrouped
		}
	}
	// Status is observation-only and cannot refresh the admitted index.
	if !check("", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all") {
		return errGrouped
	}
	return nil
}
