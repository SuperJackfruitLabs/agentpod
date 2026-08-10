package descriptor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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

// --- Node runtime selection ---
//
// Both external ACP adapters AgentPod spawns (claude-agent-acp, codex-acp) are
// Node programs, and both face the same host problem: the node the service's
// PATH offers may not be the one the operator installed for them. The selector
// below is shared; the POLICY on top of it is not — see selectNodeRuntimeDir's
// minMajor.

// nodeVersionTimeout bounds `node --version`. It runs on the gateway's acp.open
// path, so a node binary on a stalled network mount would otherwise wedge
// session opening with no error at all.
const nodeVersionTimeout = 2 * time.Second

// nodeVersionOutput runs `node --version` and returns its raw output.
func nodeVersionOutput(nodePath string) (string, error) {
	return nodeVersionOutputWithin(nodeVersionTimeout, nodePath)
}

// nodeVersionOutputWithin is nodeVersionOutput with an explicit deadline. A
// timeout surfaces as an error, which callers treat as "version unknown".
func nodeVersionOutputWithin(timeout time.Duration, nodePath string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, nodePath, "--version").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// parseNodeMajor extracts the major version from `node --version` output
// ("v22.14.0\n" → 22). ok is false when the string isn't a version at all.
func parseNodeMajor(out string) (int, bool) {
	s := strings.TrimSpace(out)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexByte(s, '.'); i != -1 {
		s = s[:i]
	}
	major, err := strconv.Atoi(s)
	if err != nil || major <= 0 {
		return 0, false
	}
	return major, true
}

// selectNodeRuntimeDir decides which node runtime an external ACP adapter will
// run under.
//
// Candidates are the configured node binary (when set) and then whatever PATH or
// the well-known dirs offer, probed via loc. The FIRST candidate new enough for
// the adapter wins; a configured node below minMajor is stepped over rather than
// enforced, because a nodeBinary key exists to supply a good runtime, never to
// downgrade a working one. A configured override that can't report a version at
// all (a typo, say) also falls through to PATH, so a mistyped key degrades to a
// check rather than to no check.
//
// dir is non-empty only when the winner is the CONFIGURED node: that one needs
// help to actually be used (callers prepend dir to the session's PATH), whereas
// a node found on PATH is what the adapter and npx would pick by themselves.
//
// tooOld is the first readable version that fell short of minMajor, and is
// returned ONLY when no candidate qualified — callers turn it into their own
// harness-specific refusal. minMajor <= 0 means the adapter documents no minimum
// version, in which case every candidate that reports a version at all qualifies
// and tooOld is always empty: refusing on a version the package never asked for
// would be inventing a requirement.
//
// No node at all, and no readable version from any candidate, is NOT an error
// here: an adapter may ship its own runtime, and the npx path fails on npx anyway.
func selectNodeRuntimeDir(configured string, minMajor int, loc binaryLocator, version func(string) (string, error)) (dir, tooOld string) {
	var candidates []string
	if configured != "" {
		candidates = append(candidates, configured)
	}
	if resolved, ok := loc.locate("node", ""); ok {
		candidates = append(candidates, resolved)
	}

	for _, nodePath := range candidates {
		out, err := version(nodePath)
		if err != nil {
			continue // unreachable, stalled, or not a node at all
		}
		major, parsed := parseNodeMajor(out)
		if !parsed {
			continue
		}
		if major < minMajor {
			if tooOld == "" {
				tooOld = strings.TrimSpace(out)
			}
			continue
		}
		if nodePath == configured {
			return filepath.Dir(nodePath), ""
		}
		return "", ""
	}

	return "", tooOld
}

// pathWithDirFirst puts dir at the front of a PATH value.
func pathWithDirFirst(dir, path string) string {
	if path == "" {
		return dir
	}
	return dir + string(os.PathListSeparator) + path
}
