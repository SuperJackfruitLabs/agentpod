package descriptor

// ConfigRefusal is why a plan will not be offered. Every code is distinct and
// carries a sentence: a refusal that cannot be told from a pass is the
// failure this area keeps hitting. Codes are spec §9's set, and the JSON
// tags match the contract's `ConfigRefusal`.
type ConfigRefusal struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ConfigPlanEntry is one setting's intended edit.
//
// Current is `any` so that a setting's real value — a string, an int, a list —
// is carried as itself rather than flattened into a typed zero, and
// `omitempty` so a key that is not in the document does not marshal a bare
// `"current": null` into the plan a human reviews.
//
// What omitempty does NOT do is distinguish an absent key from a key holding
// a YAML null: on an interface field it omits exactly when the interface is
// nil, so both marshal identically. No registered setting is nullable today,
// so nothing observable depends on telling those two apart; a setting that
// ever is would need an explicit `present` flag here rather than leaning on
// this field's absence.
type ConfigPlanEntry struct {
	SettingID           string `json:"settingId"`
	File                string `json:"file"`
	KeyPath             string `json:"keyPath"`
	Policy              string `json:"policy"`
	Current             any    `json:"current,omitempty"`
	Intended            any    `json:"intended"`
	Action              string `json:"action"` // create | modify | append | noop
	RestartToTakeEffect bool   `json:"restartToTakeEffect"`
}

// ConfigWritten is what an apply actually wrote, per setting.
type ConfigWritten struct {
	SettingID string `json:"settingId"`
	Action    string `json:"action"`
	Wrote     any    `json:"wrote"`
}

// ConfigReceipt is the journal entry for one apply. There is deliberately no
// `restarted` field: nothing here restarts a harness (D4).
type ConfigReceipt struct {
	Plan        ConfigPlan      `json:"plan"`
	Phase       string          `json:"phase"` // planned | applying | applied | conflict
	UpdatedAt   string          `json:"updatedAt"`
	Written     []ConfigWritten `json:"written"`
	AfterSHA256 string          `json:"afterSha256,omitempty"`
	Error       string          `json:"error,omitempty"`
}

// ConfigPlan is what review sees. The digest covers every field in it,
// including BeforeSHA256, so a document edited after review yields a
// different digest and the apply is refused rather than re-derived (D8).
type ConfigPlan struct {
	SchemaVersion   int               `json:"schemaVersion"`
	OperationID     string            `json:"operationId"`
	StationKey      string            `json:"stationKey"`
	Entries         []ConfigPlanEntry `json:"entries"`
	BeforeSHA256    string            `json:"beforeSha256"`
	Diff            string            `json:"diff"`
	DiffTruncated   bool              `json:"diffTruncated"`
	NoOp            bool              `json:"noOp"`
	Refusal         *ConfigRefusal    `json:"refusal,omitempty"`
	RestartRequired bool              `json:"restartRequired"`
	CreatedAt       string            `json:"createdAt"`
	PlanDigest      string            `json:"planDigest"`
}
