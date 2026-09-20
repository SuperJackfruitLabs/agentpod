package skills

type InstallBinding struct {
	NodeID            string `json:"nodeId"`
	StationKey        string `json:"stationKey"`
	Harness           string `json:"harness"`
	Profile           string `json:"profile"`
	WorkspacePath     string `json:"workspacePath"`
	WorkspaceIdentity string `json:"workspaceIdentity"`
}
type Generation struct {
	Generation    string `json:"generation"`
	ArchiveSHA256 string `json:"archiveSHA256"`
	BundleDigest  string `json:"bundleDigest"`
}
type InstallChanges struct {
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
	Changed []string `json:"changed"`
}
type InstallPlan struct {
	SchemaVersion int            `json:"schemaVersion"`
	OperationID   string         `json:"operationId"`
	Action        string         `json:"action"`
	Binding       InstallBinding `json:"binding"`
	ExpectedHead  string         `json:"expectedHead"`
	Before        *Generation    `json:"before"`
	After         *Generation    `json:"after"`
	TargetPath    *string        `json:"targetPath"`
	Changes       InstallChanges `json:"changes"`
	Activation    string         `json:"activation"`
	CreatedAt     string         `json:"createdAt"`
	PlanDigest    string         `json:"planDigest"`
}
type InstallReceipt struct {
	Plan        InstallPlan `json:"plan"`
	Phase       string      `json:"phase"`
	UpdatedAt   string      `json:"updatedAt"`
	CompletedAt *string     `json:"completedAt"`
	Error       *string     `json:"error"`
}
type InstallVerification struct {
	Current *Generation
	Path    *string
	Present Observation
	Loaded  Observation
}
