package hermeslive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The plugin apn installs is the one the CI contract ran against: the
// embedded copy must be byte-identical to integrations/hermes/agentpod-live.
// To refresh it, copy __init__.py and plugin.yaml into plugin/agentpod-live
// and hermes-tested.max into plugin/.
func TestEmbeddedPluginMatchesItsSource(t *testing.T) {
	source := filepath.Join("..", "..", "..", "..", "integrations", "hermes", "agentpod-live")
	if _, err := os.Stat(source); err != nil {
		t.Skipf("plugin source not in this checkout: %v", err)
	}
	for name, embeddedData := range Files() {
		want, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if string(want) != string(embeddedData) {
			t.Errorf("embedded %s differs from %s; copy it again", name, filepath.Join(source, name))
		}
	}
	max, err := os.ReadFile(filepath.Join(source, "hermes-tested.max"))
	if err != nil || strings.TrimSpace(string(max)) != TestedMax() {
		t.Errorf("embedded hermes-tested.max (%q) differs from the source (%q, %v)", TestedMax(), max, err)
	}
	if got := FileNames(); strings.Join(got, ",") != "__init__.py,plugin.yaml" {
		t.Errorf("embedded files = %v", got)
	}
}

func TestEmbeddedManifestCarriesTheTestedRange(t *testing.T) {
	m := EmbeddedManifest()
	if m.Name != Name || m.Version == "" {
		t.Fatalf("manifest = %+v", m)
	}
	if !strings.HasPrefix(m.RequiresHermes, ">=") || strings.Contains(m.RequiresHermes, "<") {
		t.Fatalf("requires_hermes must be a lower bound only (Hermes enforces it at load): %q", m.RequiresHermes)
	}
	if TestedMax() == "" {
		t.Fatal("hermes-tested.max is empty")
	}
}

func TestCheckHermesAcceptsOnlyTheTestedRange(t *testing.T) {
	min := strings.TrimSpace(strings.TrimPrefix(EmbeddedManifest().RequiresHermes, ">="))
	max := TestedMax()
	for _, tc := range []struct {
		version string
		allowed bool
	}{
		{min, true},
		{max, true},
		{"0.1.0", false},
		{"99.0.0", false},
	} {
		gate := CheckHermes(versionKnown, tc.version, "")
		if gate.Allowed != tc.allowed {
			t.Errorf("Hermes %s: allowed=%v (%s)", tc.version, gate.Allowed, gate.Reason)
		}
		if !gate.Allowed && gate.Reason == "" {
			t.Errorf("Hermes %s: a refusal needs a reason", tc.version)
		}
	}
}

// An undetermined version is held, never refused on version grounds.
func TestCheckHermesHoldsAnUndeterminedVersion(t *testing.T) {
	gate := CheckHermes("undetermined", "", "the version query timed out twice")
	if gate.Allowed || !strings.Contains(gate.Reason, "could not be determined") || strings.Contains(gate.Reason, "outside") {
		t.Fatalf("gate = %+v", gate)
	}
	absent := CheckHermes(versionAbsent, "", "The hermes executable is unresolved on this node")
	if absent.Allowed || !strings.Contains(absent.Reason, "not installed") {
		t.Fatalf("absent = %+v", absent)
	}
}

func TestSatisfiesFollowsHermesGrammarButRefusesWhatItCannotParse(t *testing.T) {
	for _, tc := range []struct {
		spec, version string
		want          bool
	}{
		{">=0.21.3", "0.21.3", true},
		{"0.21.3", "0.21.4", true}, // a bare version means >=
		{">=0.21.3, <=0.21.5", "0.21.6", false},
		{"!=0.21.4", "0.21.4", false},
		{">0.21.3", "0.21.3", false},
	} {
		got, err := satisfies(tc.spec, tc.version)
		if err != nil || got != tc.want {
			t.Errorf("satisfies(%q, %q) = %v, %v", tc.spec, tc.version, got, err)
		}
	}
	if _, err := satisfies(">=banana", "0.21.3"); err == nil {
		t.Error("an unparseable clause was accepted")
	}
	if _, err := satisfies(">=0.21.3", "main"); err == nil {
		t.Error("an unparseable version was accepted")
	}
}
