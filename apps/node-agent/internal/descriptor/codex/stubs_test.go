package codex

import (
	"fmt"
)

// Claude Code has no native ACP mode: sessions run through the external
// claude-agent-acp adapter. Every host-touching seam (PATH lookup, well-known
// path probing, `node --version`) is injected in every case below, so no test
// needs node, npx or claude installed and none spawns a process (see the Go
// test hygiene note in CLAUDE.md).

const (
	testStubHome = "/home/pod"
	testStubPath = "/usr/local/bin:/usr/bin:/bin"
)

// nodeVersions builds a nodeVersion seam that answers per node path; a path
// absent from the map behaves like a binary that can't be run.
func nodeVersions(versions map[string]string) func(string) (string, error) {
	return func(nodePath string) (string, error) {
		if v, ok := versions[nodePath]; ok {
			return v, nil
		}
		return "", fmt.Errorf("fork/exec %s: no such file or directory", nodePath)
	}
}
