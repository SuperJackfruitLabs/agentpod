package skills

type PlacementPlan struct {
	SchemaVersion            int            `json:"schemaVersion"`
	OperationID              string         `json:"operationId"`
	Action                   string         `json:"action"`
	Binding                  InstallBinding `json:"binding"`
	RepositoryPath           string         `json:"repositoryPath"`
	RepositoryIdentity       string         `json:"repositoryIdentity"`
	ExpectedInstallationHead string         `json:"expectedInstallationHead"`
	ExpectedHead             string         `json:"expectedHead"`
	Before                   *Generation    `json:"before"`
	After                    *Generation    `json:"after"`
	TargetPath               string         `json:"targetPath"`
	Changes                  InstallChanges `json:"changes"`
	DiscoveryNames           []string       `json:"discoveryNames"`
	Activation               string         `json:"activation"`
	CreatedAt                string         `json:"createdAt"`
	PlanDigest               string         `json:"planDigest"`
}
type PlacementReceipt struct {
	Plan        PlacementPlan `json:"plan"`
	Phase       string        `json:"phase"`
	UpdatedAt   string        `json:"updatedAt"`
	CompletedAt *string       `json:"completedAt"`
	Error       *string       `json:"error"`
}
type PlacementVerification struct {
	Current        *Generation `json:"current"`
	Path           string      `json:"path"`
	DiscoveryNames []string    `json:"discoveryNames"`
	Present        Observation `json:"present"`
	Loaded         Observation `json:"loaded"`
}

const placementActivation = "quiescent-project; loading-unverified"
