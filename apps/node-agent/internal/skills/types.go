// Package skills observes skill content without executing a harness or helper.
package skills

type Observation struct {
	Value      *bool   `json:"value"`
	ObservedAt *string `json:"observedAt"`
	Reason     string  `json:"reason"`
}
type Evidence struct {
	Catalogued Observation `json:"catalogued"`
	Present    Observation `json:"present"`
	Eligible   Observation `json:"eligible"`
	Loaded     Observation `json:"loaded"`
	Exercised  Observation `json:"exercised"`
}
type Source struct {
	Kind           string  `json:"kind"`
	Locator        *string `json:"locator"`
	Revision       *string `json:"revision"`
	ArtifactDigest *string `json:"artifactDigest"`
}
type Shadowing struct {
	Status     string   `json:"status"`
	By         *string  `json:"by"`
	Candidates []string `json:"candidates"`
}
type Dependency struct {
	Kind      string      `json:"kind"`
	Name      string      `json:"name"`
	Available Observation `json:"available"`
}
type Dependencies struct {
	Known bool         `json:"known"`
	Items []Dependency `json:"items"`
}
type Compatibility struct {
	Harness     string      `json:"harness"`
	Version     string      `json:"version"`
	Mode        string      `json:"mode"`
	Result      Observation `json:"result"`
	EvidenceRef string      `json:"evidenceRef"`
}
type Entry struct {
	ID               string          `json:"id"`
	Name             string          `json:"name"`
	Description      string          `json:"description"`
	Path             string          `json:"path"`
	Scope            string          `json:"scope"`
	Source           Source          `json:"source"`
	EntrypointDigest *string         `json:"entrypointDigest"`
	EffectivePath    *string         `json:"effectivePath"`
	Shadowing        Shadowing       `json:"shadowing"`
	Dependencies     Dependencies    `json:"dependencies"`
	Compatibility    []Compatibility `json:"compatibility"`
	Evidence         Evidence        `json:"evidence"`
}
type Plugin struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	Path       string      `json:"path"`
	Scope      string      `json:"scope"`
	Source     Source      `json:"source"`
	Components []string    `json:"components"`
	Activation Observation `json:"activation"`
	Evidence   Evidence    `json:"evidence"`
}
type RootCoverage struct {
	Path   string `json:"path"`
	Scope  string `json:"scope"`
	Status string `json:"status"`
}
type Coverage struct {
	Complete    bool           `json:"complete"`
	Roots       []RootCoverage `json:"roots"`
	Limitations []string       `json:"limitations"`
}
type Issue struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}
type Inventory struct {
	StationKey string   `json:"stationKey"`
	Harness    string   `json:"harness"`
	ObservedAt string   `json:"observedAt"`
	Skills     []Entry  `json:"skills"`
	Plugins    []Plugin `json:"plugins"`
	Coverage   Coverage `json:"coverage"`
	Issues     []Issue  `json:"issues"`
}
