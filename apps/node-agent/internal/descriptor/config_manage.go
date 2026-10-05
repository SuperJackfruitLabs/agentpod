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
	// `key`, naming operationID so this station's own journal can key a
	// receipt by it (config_journal.go). It writes nothing to the document:
	// the returned ConfigPlan carries the edited document only in its diff,
	// never to disk. A plan that cannot be offered comes back with Refusal
	// set and a nil error — a refused plan is still an answer, not a failure
	// of the call. A plan that is NOT refused is recorded in the journal
	// (phase "planned") so ApplyConfig, handed only a digest, can recover
	// what review saw.
	PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error)

	// ApplyConfig applies the plan previously reviewed as planDigest for
	// operationID: it re-derives the plan from the document as it is now and
	// refuses (phase "conflict", never an error) rather than write anything
	// if that no longer matches what planDigest names, or if planDigest does
	// not match what this station's journal actually has on record. Applying
	// an operationID already recorded as "applied" returns that receipt
	// unchanged — ApplyConfig is idempotent per operationID. Nothing here
	// starts, stops, or restarts the harness; the receipt has no `restarted`
	// field and never will (D4).
	ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error)

	// InspectConfig returns the receipt this station's journal has recorded
	// for operationID, exactly as recorded — it never re-derives or
	// re-plans. An operationID with no journal entry at all is an error, not
	// a freshly fabricated plan standing in for a review that never happened.
	InspectConfig(ctx context.Context, key, operationID string) (ConfigReceipt, error)
}
