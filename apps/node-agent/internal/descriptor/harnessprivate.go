package descriptor

import (
	"path/filepath"
	"strings"
)

// Harness-private names (HarnessPrivate): what each harness keeps in a workspace root that is
// the harness's own home. Each entry says where the descriptor (or the posture scan, which was
// checked against real hosts) reads or writes it. Names the descriptor code does not itself
// touch are marked "upstream layout".

// hermesRootPrivate is what ~/.hermes (key "hermes") holds besides the user's work.
var hermesRootPrivate = []string{
	"config.yaml",  // hermes.go multiplexProfiles + the layout comment: the root config
	"profile.yaml", // hermes.go rootDisplayName: the root display-name record
	"logs",         // hermes.go TailLogs: gateway and agent logs
	"profiles",     // hermes.go workspaceFor: every other agent's whole profile tree
	"git-identities",
	// upstream layout, not read by the descriptor: session and state stores, memory, schedules,
	// pairing and platform tokens, gateway runtime state.
	"state.db", "state.db-wal", "state.db-shm", "sessions", "memories", "cron", "pairing", "platforms",
	"gateway.pid", "gateway_state.json",
	"kanban.db", "kanban.db-wal", "kanban.db-shm", // hermes.go layout comment: the board database
}

// hermesProfilePrivate is what ~/.hermes/profiles/<name> holds besides the user's work (the
// per-profile mirror of the root list; .env and auth.json are already in the path denylist).
var hermesProfilePrivate = []string{
	"config.yaml", // hermes.go multiplexProfiles / configedit: the profile config
	"logs",        // hermes.go TailLogs: profile logs
	"state.db", "state.db-wal", "state.db-shm", "sessions", "memories", "cron", "pairing", "platforms",
	"gateway.pid", "gateway_state.json", "kanban.db", "kanban.db-wal", "kanban.db-shm", // upstream layout / layout comment
}

// HarnessPrivate implements HarnessPrivate for Hermes.
func (h *hermesDescriptor) HarnessPrivate(key string) []string {
	if key == "hermes" {
		return hermesRootPrivate
	}
	return hermesProfilePrivate
}

// openclawHomePrivate applies only when the root is the OpenClaw home itself (no <home>/workspace).
var openclawHomePrivate = []string{
	"openclaw.json",                                       // openclaw.go openclawConfigPort + layout comment: the main config, gateway token included
	"openclaw.json.bak",                                   // upstream layout: the config's backup
	"credentials",                                         // posture/creds.go: .openclaw/credentials/*.json
	"gateway.systemd.env",                                 // posture/creds.go: the unit's environment
	"agents",                                              // openclaw.go resolveAgentWorkspace: every agent's config, auth profiles, sessions
	"logs",                                                // openclaw.go TailLogs
	"devices", "identity", "exec-approvals.json", "state", // upstream layout: pairing, device identity, approvals, runtime state
}

// openclawAgentPrivate applies when the root is <home>/agents/<name>: the agent's own config dir.
var openclawAgentPrivate = []string{
	"agent",              // upstream layout: agent/auth-profiles.json, agent/models.json (posture/creds.go comment)
	"sessions",           // upstream layout: session transcripts
	"auth-profiles.json", // posture/creds.go: provider keys by name
}

// HarnessPrivate implements HarnessPrivate for OpenClaw.
func (o *openclawDescriptor) HarnessPrivate(key string) []string {
	root, err := o.workspaceFor(key)
	if err != nil {
		return []string{"."} // unknown station: nothing is readable
	}
	var out []string
	if filepath.Clean(root) == filepath.Clean(o.home) {
		out = append(out, openclawHomePrivate...)
	}
	if name := strings.TrimPrefix(key, "openclaw:"); key != "openclaw" && filepath.Clean(root) == filepath.Join(filepath.Clean(o.home), "agents", name) {
		out = append(out, openclawAgentPrivate...)
	}
	return out
}

// The four project harnesses use a project directory as the root, never their own home, unless a
// project is opened AT the home (cwd ~/.claude, ~/.pi/agent, ~/.local/share/opencode): then the
// whole root is the harness's private files and nothing in it is linkable.
func privateIfHome(root string, err error) []string {
	if err != nil || rootInDeniedTree(root) {
		return []string{"."}
	}
	return nil
}

// HarnessPrivate implements HarnessPrivate for Claude Code.
func (c *claudeCodeDescriptor) HarnessPrivate(key string) []string {
	return privateIfHome(c.projectPathForKey(key))
}

// HarnessPrivate implements HarnessPrivate for Codex.
func (c *codexDescriptor) HarnessPrivate(key string) []string {
	return privateIfHome(c.projectPathForKey(key))
}

// HarnessPrivate implements HarnessPrivate for OpenCode.
func (o *openCodeDescriptor) HarnessPrivate(key string) []string {
	return privateIfHome(o.projectPathForKey(key))
}

// HarnessPrivate implements HarnessPrivate for Pi.
func (p *piDescriptor) HarnessPrivate(key string) []string {
	return privateIfHome(p.workspaceForKey(key))
}
