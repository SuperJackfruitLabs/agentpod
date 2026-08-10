package descriptor

import (
	"os"
	"path/filepath"
)

// This file holds the one way descriptors find an executable on a node.
//
// Every harness bridge has the same problem: the node-agent commonly runs as a
// systemd *user* service, which inherits systemd's minimal default PATH — that
// excludes ~/.local/share/pnpm and ~/.local/bin, so a pnpm/npm-global install
// is invisible to exec.LookPath even though the shim works fine in the
// operator's interactive shell. Hence: config override → PATH → well-known
// absolute paths.

// wellKnownBinaryDirs returns the directories probed when a binary is not on
// PATH, in priority order. userHome is the OS user's home directory; "" omits
// the home-relative candidates (a relative ".local/share/pnpm/x" candidate
// would be garbage).
func wellKnownBinaryDirs(userHome string) []string {
	var dirs []string
	if userHome != "" {
		dirs = append(dirs,
			filepath.Join(userHome, ".local", "share", "pnpm"), // pnpm global
			filepath.Join(userHome, ".local", "bin"),           // npm --prefix ~/.local
		)
	}
	return append(dirs,
		"/usr/local/bin",
		"/usr/bin",
		"/opt/homebrew/bin", // macOS (Apple silicon Homebrew)
	)
}

// binaryLocator resolves executable names to absolute paths. lookPath and
// isExecutable are fields so tests never touch the host's PATH or filesystem.
type binaryLocator struct {
	// userHome is the OS user's home directory, or "" when undeterminable.
	userHome string
	// preferDirs are probed BEFORE PATH. They exist for the case where a
	// configured runtime must beat whatever PATH offers — e.g. the npx beside a
	// configured node, when PATH's npx belongs to an older one.
	preferDirs []string
	// lookPath is exec.LookPath in production.
	lookPath func(string) (string, error)
	// isExecutable is isExecutableFile in production.
	isExecutable func(string) bool
}

// locate resolves the executable named name, in order: the configured override
// (used verbatim — the operator knows their layout, and second-guessing it with
// a PATH lookup would defeat the escape hatch), then preferDirs, then PATH, then
// the well-known install directories. The second return value reports whether
// anything was found; callers own the (harness-specific, actionable) error.
func (l binaryLocator) locate(name, override string) (string, bool) {
	if override != "" {
		return override, true
	}
	for _, dir := range l.preferDirs {
		if candidate := filepath.Join(dir, name); l.isExecutable(candidate) {
			return candidate, true
		}
	}
	if abs, err := l.lookPath(name); err == nil {
		return abs, true
	}
	for _, dir := range wellKnownBinaryDirs(l.userHome) {
		if candidate := filepath.Join(dir, name); l.isExecutable(candidate) {
			return candidate, true
		}
	}
	return "", false
}

// isExecutableFile reports whether path is an existing file with an executable
// bit set. os.Stat follows symlinks, so a pnpm shim (a symlink) resolves.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode()&0o111 != 0
}
