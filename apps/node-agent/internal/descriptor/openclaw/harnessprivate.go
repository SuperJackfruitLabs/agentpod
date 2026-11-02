package openclaw

import (
	"path/filepath"
	"strings"
)

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
func (o *Descriptor) HarnessPrivate(key string) []string {
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
