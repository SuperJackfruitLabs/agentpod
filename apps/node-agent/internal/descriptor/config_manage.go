package descriptor

import "context"

// ConfigSetting is one registered harness setting. Mirrors the contract's
// `ConfigSetting`; the JSON tags MUST match it exactly.
type ConfigSetting struct {
	ID                  string `json:"id"`
	Harness             string `json:"harness"`
	Scope               string `json:"scope"`  // "profile" | "project" | "user"
	Policy              string `json:"policy"` // "reconcilable" | "additive-only" | "report-only"
	RestartToTakeEffect bool   `json:"restartToTakeEffect"`
}

// ConfigValue is what a station actually has for one setting.
//
// There is deliberately no `declared` field and no "drifted" flag: the node is
// not told what the fleet wants, so it cannot and must not decide whether a
// value is drift. Only the hub resolves station → node → fleet precedence.
type ConfigValue struct {
	SettingID string `json:"settingId"`
	Observed  any    `json:"observed,omitempty"`
	// Readable is false when the document could not be read or parsed. It is a
	// field rather than an inference because an unreadable document must never
	// look like a document whose key is absent.
	Readable bool   `json:"readable"`
	Reason   string `json:"reason,omitempty"`
}

// DeclaredSetting is one setting the fleet wants, at whatever level the
// caller already resolved to a single value — PlanConfig is not told about
// station/node/fleet precedence, only the one value that won it. Mirrors the
// contract's `DeclaredSetting` down to `settingId`/`value`; `stationId` and
// `nodeId` are the hub's bookkeeping and never reach the node.
type DeclaredSetting struct {
	SettingID string `json:"settingId"`
	Value     any    `json:"value"`
}

// ConfigManager is an OPTIONAL interface for descriptors that can read a
// registered subset of their harness's own configuration, and plan — but
// never itself perform — an edit to it.
//
// `config.manage` is advertised in Detect output ONLY when the descriptor
// implements this and the station's WorkspacePath is absolute — the same gate
// `skills.manage` uses.
type ConfigManager interface {
	// ConfigSettings is this harness's registry: every setting it can manage.
	// An id absent here is refused by name, never read speculatively.
	ConfigSettings() []ConfigSetting

	// ObserveConfig reads the current values for `settings` on the station
	// `key`. It never writes and never restarts.
	ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error)

	// PlanConfig derives the edit that would satisfy `want` on the station
	// `key`, naming operationID so the journal (a later task) can key its
	// receipt by it. It writes nothing: the returned ConfigPlan carries the
	// edited document only in its diff, never to disk. A plan that cannot be
	// offered comes back with Refusal set and a nil error — a refused plan is
	// still an answer, not a failure of the call.
	PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error)
}
