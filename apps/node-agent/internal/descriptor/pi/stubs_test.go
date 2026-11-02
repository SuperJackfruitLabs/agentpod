package pi

// Claude Code has no native ACP mode: sessions run through the external
// claude-agent-acp adapter. Every host-touching seam (PATH lookup, well-known
// path probing, `node --version`) is injected in every case below, so no test
// needs node, npx or claude installed and none spawns a process (see the Go
// test hygiene note in CLAUDE.md).

const (
	testStubHome = "/home/pod"
	testStubPath = "/usr/local/bin:/usr/bin:/bin"
)
