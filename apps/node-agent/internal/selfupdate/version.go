package selfupdate

import (
	"fmt"
	"strconv"
	"strings"
)

// CompareVersions reports how release tag `a` relates to release tag `b`:
// negative when a is older, zero when they are the same version, positive
// when a is newer. A non-numeric version component is an error — never a
// silent "same", which would suppress a needed update.
//
// Why this exists in Go when the repo already has a comparator
// ------------------------------------------------------------
// fly/node-image/check-version-pin.sh (#292) is the repo's reference answer to
// "which of these two release tags is newer", and it is deliberately correct
// about the case a string compare gets wrong: lexically "v0.1.9" > "v0.1.24",
// so string ordering would call a two-release-stale agent current.
//
// A shipped agentpod-node binary cannot call that script. It lives in the Fly
// image directory, is not part of any release artifact, and the nodes that
// most need this comparison (a Raspberry Pi, a Modal container) never have the
// repo on disk. So a Go implementation is unavoidable.
//
// What is avoidable is a SECOND, subtly different comparator. This function is
// a deliberate port with identical semantics, and
// TestCompareVersions_AgreesWithCheckVersionPinScript runs both over one table
// and fails if they ever disagree. Change one, change the other.
//
// Semantics, matching the script exactly:
//   - a leading "v" is optional and ignored
//   - everything from the first "-" is a pre-release suffix, compared last
//   - the numeric part is compared component-wise and NUMERICALLY, over as
//     many components as the longer side has; a missing component is 0, so
//     v0.1 and v0.1.0 are the same version and "" is 0.0.0 (behind every real
//     release, which is the safe direction — it lets an update proceed)
//   - on a numeric tie a pre-release precedes the release it leads to, so
//     v0.1.25-rc1 is older than v0.1.25; two pre-releases compare as strings
func CompareVersions(a, b string) (int, error) {
	aNum, aPre := splitVersion(a)
	bNum, bPre := splitVersion(b)

	aParts := strings.Split(aNum, ".")
	bParts := strings.Split(bNum, ".")
	n := max(len(aParts), len(bParts))

	for i := 0; i < n; i++ {
		ai, err := versionComponent(aParts, i, a)
		if err != nil {
			return 0, err
		}
		bi, err := versionComponent(bParts, i, b)
		if err != nil {
			return 0, err
		}
		if ai != bi {
			if ai < bi {
				return -1, nil
			}
			return 1, nil
		}
	}

	// Numerically equal: a pre-release precedes the release it leads to
	// (semver), which keeps v0.1.25-rc1 from passing as v0.1.25.
	switch {
	case aPre != "" && bPre == "":
		return -1, nil
	case aPre == "" && bPre != "":
		return 1, nil
	case aPre == bPre:
		return 0, nil
	case aPre < bPre:
		return -1, nil
	default:
		return 1, nil
	}
}

// splitVersion strips an optional leading "v" and splits off everything from
// the first "-" as the pre-release suffix.
func splitVersion(v string) (numeric, pre string) {
	v = strings.TrimPrefix(v, "v")
	if i := strings.Index(v, "-"); i != -1 {
		return v[:i], v[i+1:]
	}
	return v, ""
}

// versionComponent returns component i of parts as an integer. A component
// past the end, or an empty one, is 0; anything non-numeric is an error
// naming the original version string.
func versionComponent(parts []string, i int, original string) (int, error) {
	if i >= len(parts) || parts[i] == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(parts[i])
	if err != nil || n < 0 {
		return 0, fmt.Errorf("selfupdate: not a numeric version: %q", original)
	}
	return n, nil
}
