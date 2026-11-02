package descriptor

// A version probe has three honest outcomes, and a gate must be able to tell
// them apart:
//
//   - known: the version was read.
//   - absent: there is no such harness here to ask.
//   - undetermined: something is here, but its version could not be read this
//     time. A probe that ran out of time lands here, never in the other two;
//     treating a slow cold start as a missing or out-of-range harness is how a
//     canary once read a working Pi as "version unavailable".
const (
	VersionKnown        = "known"
	VersionAbsent       = "absent"
	VersionUndetermined = "undetermined"
)

// VersionProbe is one observation of a harness version. It is never cached as
// a verdict: undetermined means "ask again", not "no".
type VersionProbe struct {
	Version  string `json:"version,omitempty"`
	Status   string `json:"status"`
	Reason   string `json:"reason"`
	TimedOut bool   `json:"timedOut,omitempty"`
}
