package descriptor

// ProfileWriter writes a Matrix credential into a harness profile.
//
// Writing is NOT a heuristic: each implementation names the one file its
// harness actually loads at startup. See the note in matrix.go — the reader
// searches three locations, and a writer that copied that precedence could
// write a file the harness never reads while the reader reports a converged
// identity. That is a fleet outage with a green signal in front of it.
type ProfileWriter interface {
	// Harness returns the harness identifier this writer targets (e.g. "hermes").
	Harness() string

	// Write installs mxid and accessToken as the harness's Matrix credential
	// in the profile at profileDir. It refuses (returns an error, writes
	// nothing) when profileDir does not have the shape this harness expects —
	// that is an unrecognised profile, not a place to guess.
	Write(profileDir, mxid, accessToken string) error
}
