package descriptor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
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

// harnessCommand builds an exec of a harness binary with that binary's own
// directory leading PATH.
//
// Every such exec needs this, not just the version probe. `pi`, `pi-acp` and
// `openclaw` are Node programs whose interpreter sits beside them, and a
// node-agent started by launchd or systemd inherits a PATH without it. The
// version probe was fixed for exactly this reason; the harness REPORT commands
// were not, so readiness passed on a harness whose inventory then failed with
// `exit status 127: env: node: No such file or directory`. One helper serves
// both so the two cannot drift apart again.
//
// The binary's directory leads rather than trails, so a same-named binary
// earlier on the service PATH cannot answer for the one actually selected.
func harnessCommand(ctx context.Context, binary string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = append(os.Environ(), "PATH="+pathWithDirFirst(filepath.Dir(binary), os.Getenv("PATH")))
	return cmd
}

// wellKnownBinaryDirs returns the directories probed when a binary is not on
// PATH, in priority order. userHome is the OS user's home directory; "" omits
// the home-relative candidates (a relative ".local/share/pnpm/x" candidate
// would be garbage).
// nodeVersionManagerBins returns the bin directory of each node installed under
// nvm, newest version first.
//
// Sorting is by descending directory name, which orders the vN.N.N layout nvm
// uses correctly for every version this will meet in practice. An unreadable or
// absent ~/.nvm yields nothing rather than an error: this is a set of
// candidates, and a missing version manager is the ordinary case.
func nodeVersionManagerBins(userHome string) []string {
	root := filepath.Join(userHome, ".nvm", "versions", "node")
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	dirs := make([]string, 0, len(names))
	for _, name := range names {
		dirs = append(dirs, filepath.Join(root, name, "bin"))
	}
	return dirs
}

func wellKnownBinaryDirs(userHome string) []string {
	var dirs []string
	if userHome != "" {
		dirs = append(dirs,
			filepath.Join(userHome, ".local", "share", "pnpm"), // pnpm global
			filepath.Join(userHome, ".local", "bin"),           // npm --prefix ~/.local
		)
		// A harness installed with `npm i -g` under a node version manager
		// lands in that node's own bin directory rather than any fixed path --
		// OpenClaw installs exactly this way. Newest version first, so an old
		// one left behind by an upgrade cannot shadow the CLI the operator
		// actually uses.
		dirs = append(dirs, nodeVersionManagerBins(userHome)...)
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
//
// A query that times out is retried once: under load a cold `node --version`
// can overrun the bound, and reading that as "version unknown" silently drops
// the configured runtime from PATH.
func nodeVersionOutputWithin(timeout time.Duration, nodePath string) (string, error) {
	probe := probeVersion(context.Background(), timeout, func(ctx context.Context) (string, error) {
		out, err := exec.CommandContext(ctx, nodePath, "--version").Output()
		return string(out), err
	})
	if probe.Status != VersionKnown {
		return "", errors.New(probe.Reason)
	}
	return probe.Version, nil
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
