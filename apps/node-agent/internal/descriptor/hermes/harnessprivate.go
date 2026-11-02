package hermes

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
func (h *Descriptor) HarnessPrivate(key string) []string {
	if key == "hermes" {
		return hermesRootPrivate
	}
	return hermesProfilePrivate
}
