package descriptor

// TransportProber answers whether the thing an ACP bridge talks THROUGH is
// reachable right now.
//
// Deliberately not Health. `Health.Running` is a process check, and a process
// check cannot see the failure this exists for: on 2026-10-03 an OpenClaw
// gateway was alive — `pgrep` found it, systemd called it active — while its
// socket refused every connection, because its bind profile contradicted its
// mode. The bridge stayed up holding a dead socket and rejected three prompts
// in a row with a bare JSON-RPC "Internal error".
//
// Nothing in the words of that rejection could ever reveal the cause. A dial
// can, which is the entire argument for this interface.
//
// Optional: a harness whose descriptor does not implement it simply has no
// answer, and a caller must treat "no answer" as "unknown" rather than as
// "unreachable". Reporting a healthy harness as disconnected would be the same
// confident-wrong-answer failure in the opposite direction.
type TransportProber interface {
	// ProbeTransport never returns an error. A probe that could not be made is
	// an unreachable transport with the reason in Detail — the caller is asking
	// in order to explain a failure to a person, and an error there would only
	// become a second thing to explain.
	ProbeTransport(key string) TransportProbe
}

// TransportProbe is what a single reachability check learned.
type TransportProbe struct {
	Reachable bool `json:"reachable"`
	// The address actually tried, so a reader can tell "refused" from "I probed
	// the wrong place" — which is exactly the mistake that caused the incident
	// this was written for.
	Address string `json:"address,omitempty"`
	// The dial's own words when it failed. "Unreachable" on its own sends a
	// reader back to the logs to find out what everyone already knew.
	Detail string `json:"detail,omitempty"`
}
