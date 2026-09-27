// Package hermeslive installs the agentpod-live Hermes plugin into a Hermes
// profile, enables it, and reports what it observes of it (#553).
//
// The plugin streams a harness-mode Hermes turn to AgentPod clients. It ships
// inside each apn release, pinned to the copy the CI contract ran against, so
// the plugin and the hub's live-event protocol it speaks cannot drift apart.
// Installing and enabling is an operator action on the host, like
// `apn hermes-skills register`: it edits a profile the operator runs, shows the
// exact change first, and is reversed by `disable`.
package hermeslive

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Name is the plugin's directory and manifest name.
const Name = "agentpod-live"

// The embedded copy is kept identical to integrations/hermes/agentpod-live by
// TestEmbeddedPluginMatchesItsSource and by the hermes-plugin workflow.
//
//go:embed plugin/agentpod-live/__init__.py plugin/agentpod-live/plugin.yaml plugin/hermes-tested.max
var embedded embed.FS

// Files returns the plugin's files, keyed by their path inside the plugin
// directory.
func Files() map[string][]byte {
	out := map[string][]byte{}
	_ = fs.WalkDir(embedded, "plugin/"+Name, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := embedded.ReadFile(p)
		if err != nil {
			return err
		}
		out[strings.TrimPrefix(p, "plugin/"+Name+"/")] = data
		return nil
	})
	return out
}

// Manifest is the part of plugin.yaml the installer reads.
type Manifest struct {
	Name           string `yaml:"name"`
	Version        string `yaml:"version"`
	RequiresHermes string `yaml:"requires_hermes"`
}

// ParseManifest reads a plugin.yaml.
func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := yaml.Unmarshal(data, &m); err != nil {
		return Manifest{}, fmt.Errorf("hermes-live: plugin.yaml is not valid YAML: %w", err)
	}
	if m.Name == "" || m.Version == "" {
		return Manifest{}, fmt.Errorf("hermes-live: plugin.yaml has no name or version")
	}
	return m, nil
}

// EmbeddedManifest is the manifest of the plugin this apn ships.
func EmbeddedManifest() Manifest {
	m, err := ParseManifest(Files()["plugin.yaml"])
	if err != nil {
		// The embedded file is part of the binary; a test pins that it parses.
		panic(err)
	}
	return m
}

// TestedMax is the newest Hermes the CI contract passed against when this
// plugin was built. Installing on a newer Hermes is refused: it is untested.
func TestedMax() string {
	data, _ := embedded.ReadFile("plugin/hermes-tested.max")
	return strings.TrimSpace(string(data))
}

// Digest identifies a set of plugin files: the sorted relative paths, each with
// the SHA-256 of its bytes. It is the same over an embedded copy and over the
// files on disk, so "is this exactly what apn installs" is one comparison.
func Digest(files map[string][]byte) string {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		sum := sha256.Sum256(files[name])
		fmt.Fprintf(h, "%s\x00%x\n", path.Clean(name), sum)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ---- Hermes version gate ----------------------------------------------------

var versionClause = regexp.MustCompile(`^(>=|<=|==|!=|>|<)?\s*([0-9][0-9A-Za-z.]*)$`)

func versionTuple(v string) ([]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	if len(parts) < 1 || len(parts) > 4 {
		return nil, false
	}
	out := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil, false
		}
		if i < 3 {
			out[i] = n
		}
	}
	return out, true
}

func compareVersions(a, b []int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// satisfies reports whether version meets spec, with Hermes's own grammar:
// comma-separated clauses that must all hold, and a bare version meaning >=.
// Unlike Hermes at load time, which is permissive, an unparseable spec or
// version is an error: the installer refuses rather than guess.
func satisfies(spec, version string) (bool, error) {
	cur, ok := versionTuple(version)
	if !ok {
		return false, fmt.Errorf("Hermes version %q is not a version this installer can compare", version)
	}
	for _, clause := range strings.Split(spec, ",") {
		clause = strings.TrimSpace(clause)
		if clause == "" {
			continue
		}
		m := versionClause.FindStringSubmatch(clause)
		if m == nil {
			return false, fmt.Errorf("requires_hermes clause %q does not parse", clause)
		}
		target, ok := versionTuple(m[2])
		if !ok {
			return false, fmt.Errorf("requires_hermes clause %q does not parse", clause)
		}
		c := compareVersions(cur, target)
		var holds bool
		switch m[1] {
		case ">=", "":
			holds = c >= 0
		case "<=":
			holds = c <= 0
		case "==":
			holds = c == 0
		case "!=":
			holds = c != 0
		case ">":
			holds = c > 0
		case "<":
			holds = c < 0
		}
		if !holds {
			return false, nil
		}
	}
	return true, nil
}

// Version probe outcomes, as descriptor.VersionProbe reports them. They are
// passed in as strings so this package does not depend on the descriptors.
const (
	versionKnown  = "known"
	versionAbsent = "absent"
)

// Gate is the install-time version decision.
type Gate struct {
	Allowed bool   `json:"allowed"`
	Version string `json:"version,omitempty"`
	Reason  string `json:"reason"`
}

// CheckHermes decides whether this plugin may be installed on a Hermes whose
// version probe reported status/version/reason. The range is the plugin's
// requires_hermes (the oldest CI-tested Hermes, which Hermes also enforces at
// load) and TestedMax (the newest, which only the installer enforces).
func CheckHermes(status, version, reason string) Gate {
	switch status {
	case versionKnown:
	case versionAbsent:
		return Gate{Reason: "Hermes is not installed on this node: " + reason}
	default:
		// Undetermined is not a refusal of the version, and must not read as one.
		return Gate{Reason: "The Hermes version could not be determined, so the install is held rather than refused on version: " + reason + ". Run the command again."}
	}
	m := EmbeddedManifest()
	spec := m.RequiresHermes
	if max := TestedMax(); max != "" {
		spec = strings.TrimSpace(strings.Trim(spec+", <="+max, ", "))
	}
	ok, err := satisfies(spec, version)
	if err != nil {
		return Gate{Version: version, Reason: err.Error()}
	}
	if !ok {
		return Gate{Version: version, Reason: fmt.Sprintf(
			"Hermes %s is outside the range the %s %s contract was tested against (%s). Update hermes-fleet.ref or hermes-tested.max only after the hermes-plugin CI contract passes on that Hermes.",
			version, Name, m.Version, spec)}
	}
	return Gate{Allowed: true, Version: version, Reason: fmt.Sprintf("Hermes %s is inside the tested range %s", version, spec)}
}
