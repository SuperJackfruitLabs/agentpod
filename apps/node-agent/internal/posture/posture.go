// Package posture implements the checks behind `apn scan` — a free, hubless
// security check for agent runtimes.
//
// Design rules, from the strategy's §8:
//
//   - **No hub, no signup, no network.** The scan must be runnable by someone
//     who has never heard of us, on a box we will never see. That is what makes
//     it top-of-funnel rather than a feature.
//   - **No CVE feed.** A version-to-CVE database rots the moment it ships and
//     turns a static binary into something that needs updating to stay honest.
//     Every check here is a property of the machine as it is right now.
//   - **No false alarms.** A scanner that cries wolf gets ignored, so a check
//     that cannot determine an answer reports `StatusUnknown` and says why —
//     it never guesses and never reports a problem it has not seen.
package posture

import "sort"

type Severity string

const (
	// SeverityCritical is reserved for "someone else can use this agent, or
	// read the keys that drive it" — reachable from another machine, or
	// credentials any local user can read.
	SeverityCritical Severity = "critical"
	SeverityWarning  Severity = "warning"
	SeverityInfo     Severity = "info"
)

// Rank orders severities for sorting and grading. Higher is worse.
func (s Severity) Rank() int {
	switch s {
	case SeverityCritical:
		return 3
	case SeverityWarning:
		return 2
	case SeverityInfo:
		return 1
	}
	return 0
}

type Status string

const (
	StatusPass    Status = "pass"
	StatusFail    Status = "fail"
	StatusUnknown Status = "unknown" // could not determine — never treated as a pass
)

// Finding is one observation about one thing. Findings are data, not prose:
// `Check` is a stable id so a report can be diffed across runs, and `Remedy` is
// the specific action, not general advice.
type Finding struct {
	Check    string   `json:"check"`
	Status   Status   `json:"status"`
	Severity Severity `json:"severity"`
	Harness  string   `json:"harness,omitempty"`
	Station  string   `json:"station,omitempty"`
	Title    string   `json:"title"`
	Detail   string   `json:"detail"`
	Path     string   `json:"path,omitempty"`
	Remedy   string   `json:"remedy,omitempty"`
}

// Report is the whole scan.
type Report struct {
	Hostname string    `json:"hostname"`
	Stations int       `json:"stations"`
	Findings []Finding `json:"findings"`
	Grade    string    `json:"grade"`
}

// Grade summarises a report in one letter.
//
//	A — nothing found
//	B — informational findings only
//	C — at least one warning
//	F — at least one critical: an agent reachable from elsewhere, or its keys
//	    readable by any local user
//
// StatusUnknown never improves a grade and never worsens it — an
// undeterminable check is reported honestly and excluded from scoring, because
// grading on ignorance is how a scanner earns distrust.
func Grade(findings []Finding) string {
	worst := 0
	for _, f := range findings {
		if f.Status != StatusFail {
			continue
		}
		if r := f.Severity.Rank(); r > worst {
			worst = r
		}
	}
	switch worst {
	case 3:
		return "F"
	case 2:
		return "C"
	case 1:
		return "B"
	}
	return "A"
}

// Sort orders findings worst-first, then by check id, so a report reads
// top-down and two runs of the same machine produce identical output.
func Sort(findings []Finding) {
	sort.SliceStable(findings, func(i, j int) bool {
		fi, fj := findings[i], findings[j]
		// Failures before passes, regardless of severity.
		if (fi.Status == StatusFail) != (fj.Status == StatusFail) {
			return fi.Status == StatusFail
		}
		if fi.Severity.Rank() != fj.Severity.Rank() {
			return fi.Severity.Rank() > fj.Severity.Rank()
		}
		if fi.Check != fj.Check {
			return fi.Check < fj.Check
		}
		return fi.Path < fj.Path
	})
}

// ExitCode maps a report to a process exit status, so `apn scan` is usable in
// CI and cron without parsing its output.
//
//	0 — grade A or B
//	1 — grade C (warnings)
//	2 — grade F (critical)
func ExitCode(grade string) int {
	switch grade {
	case "F":
		return 2
	case "C":
		return 1
	}
	return 0
}
