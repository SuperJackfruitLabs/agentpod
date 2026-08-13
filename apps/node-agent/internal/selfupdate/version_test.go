package selfupdate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// checkVersionPinScript is the POSIX sh comparator that guards the Fly image
// pins (issue #292). It is the repo's pre-existing answer to "which of these
// two release tags is newer", and CompareVersions must agree with it — see
// TestCompareVersions_AgreesWithCheckVersionPinScript.
const checkVersionPinScript = "../../../../fly/node-image/check-version-pin.sh"

// versionCases are the (a, b) pairs both comparators must agree on.
// `want` uses the shell script's vocabulary so the differential test can
// compare strings directly.
var versionCases = []struct {
	a, b string
	want string
}{
	// The case that makes a lexical comparison wrong: "v0.1.9" > "v0.1.24"
	// as strings, so a string compare would call a two-release-stale agent
	// current and skip the update it actually needs.
	{"v0.1.9", "v0.1.24", "older"},
	{"v0.1.24", "v0.1.9", "newer"},

	{"v0.1.25", "v0.1.25", "same"},
	{"v0.1.24", "v0.1.25", "older"},
	{"v0.1.25", "v0.1.24", "newer"},

	// A missing "v" prefix is the same version.
	{"0.1.25", "v0.1.25", "same"},
	{"v0.1.25", "0.1.25", "same"},

	// A missing component is zero.
	{"v0.1", "v0.1.0", "same"},
	{"v0.1.0", "v0.1", "same"},
	{"v0.1", "v0.1.1", "older"},

	{"v0.2.0", "v0.1.99", "newer"},
	{"v1.0.0", "v0.9.9", "newer"},
	{"v0.9.9", "v1.0.0", "older"},

	// Pre-releases precede the release they lead to (semver).
	{"v0.1.25-rc1", "v0.1.25", "older"},
	{"v0.1.25", "v0.1.25-rc1", "newer"},
	{"v0.1.25-rc1", "v0.1.25-rc1", "same"},
	{"v0.1.25-rc1", "v0.1.25-rc2", "older"},
	{"v0.1.25-rc2", "v0.1.25-rc1", "newer"},
	{"v0.1.26", "v0.1.25-rc1", "newer"},

	// A missing or partial version reads as zeroes, so it is BEHIND every real
	// release — which is the safe direction: it lets the update proceed. The
	// pre-`update`-verb agents in the fleet report an empty version.
	{"", "v0.1.25", "older"},
	{"v0.1.25", "", "newer"},
	{"v..1", "v0.1.25", "older"},
}

// relationOf maps CompareVersions' int result onto the shell script's words.
func relationOf(cmp int) string {
	switch {
	case cmp < 0:
		return "older"
	case cmp > 0:
		return "newer"
	default:
		return "same"
	}
}

func TestCompareVersions(t *testing.T) {
	for _, tc := range versionCases {
		cmp, err := CompareVersions(tc.a, tc.b)
		if err != nil {
			t.Errorf("CompareVersions(%q, %q): unexpected error: %v", tc.a, tc.b, err)
			continue
		}
		if got := relationOf(cmp); got != tc.want {
			t.Errorf("CompareVersions(%q, %q) = %s, want %s", tc.a, tc.b, got, tc.want)
		}
	}
}

// A non-numeric version must be an error, never a silent "same" — "same"
// would suppress a needed update. The agent's own default build version is
// the literal "dev" (cmd/agentpod-node/main.go), so this is the everyday case
// on a locally built binary, not a corner case. check-version-pin.sh exits 2
// on the same inputs; this is the Go spelling of that.
func TestCompareVersions_NonNumericIsAnError(t *testing.T) {
	// Each of these makes check-version-pin.sh exit 2 against "v0.1.25".
	// "v1.2.3.beta" deliberately is NOT here: both comparators short-circuit
	// on the first differing component (1 > 0) and never look at "beta".
	for _, v := range []string{"dev", "v0.1.x", "latest", "v0.1.25.beta"} {
		if _, err := CompareVersions(v, "v0.1.25"); err == nil {
			t.Errorf("CompareVersions(%q, \"v0.1.25\"): want an error, got nil", v)
		}
		if _, err := CompareVersions("v0.1.25", v); err == nil {
			t.Errorf("CompareVersions(\"v0.1.25\", %q): want an error, got nil", v)
		}
	}
}

// The repo already had a correct comparator before this one existed:
// fly/node-image/check-version-pin.sh --compare A B. A shipped Go binary
// cannot shell out to a script that lives in the Fly image directory and is
// not part of a release artifact, so a Go implementation is unavoidable — but
// "unavoidable" must not become "subtly different". This test runs both over
// the same table and requires the answers to match exactly.
func TestCompareVersions_AgreesWithCheckVersionPinScript(t *testing.T) {
	script, err := filepath.Abs(checkVersionPinScript)
	if err != nil {
		t.Fatalf("resolve script path: %v", err)
	}
	if _, err := os.Stat(script); err != nil {
		t.Skipf("%s not present in this checkout: %v", checkVersionPinScript, err)
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skipf("no POSIX sh available: %v", err)
	}

	for _, tc := range versionCases {
		out, err := exec.Command(sh, script, "--compare", tc.a, tc.b).Output()
		if err != nil {
			t.Fatalf("check-version-pin.sh --compare %s %s: %v", tc.a, tc.b, err)
		}
		shellSays := strings.TrimSpace(string(out))

		cmp, err := CompareVersions(tc.a, tc.b)
		if err != nil {
			t.Errorf("CompareVersions(%q, %q): unexpected error: %v", tc.a, tc.b, err)
			continue
		}
		if got := relationOf(cmp); got != shellSays {
			t.Errorf(
				"comparators disagree on (%q, %q): Go says %s, check-version-pin.sh says %s",
				tc.a, tc.b, got, shellSays,
			)
		}
	}
}
