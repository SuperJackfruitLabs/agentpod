package posture

import (
	"os"
	"path/filepath"
	"sort"
)

// StationCredentialLayout describes where a composite harness keeps per-station
// secrets. Only composite harnesses have these; claude-code, codex and opencode
// keep everything at the host level.
type StationCredentialLayout struct {
	Harness string
	// ProfilesDir is relative to home and holds one directory per station.
	ProfilesDir string
	// Files are relative to a station's directory.
	Files []string
	// KeyPrefix builds the station key as KeyPrefix + ":" + <dir name>, matching
	// what the descriptors produce so the console can join on equality.
	KeyPrefix string
}

// StationCredentialLayouts is the observed layout of each composite harness.
//
// Verified 2026-08-11: molt-bot has 15 Hermes profiles each with auth.json and
// .env; superchotu has 12 OpenClaw agents each with agent/auth*.json. The
// descriptors read auth.json from these same directories for station identity,
// and MatrixIDFromProfile's own comment notes it ignores the other fields
// "including access_token" — which is how we know they hold live credentials.
var StationCredentialLayouts = []StationCredentialLayout{
	{
		Harness:     "hermes",
		ProfilesDir: ".hermes/profiles",
		Files:       []string{"auth.json", ".env"},
		KeyPrefix:   "hermes", // hermes.go: key = "hermes:" + name
	},
	{
		Harness:     "openclaw",
		ProfilesDir: ".openclaw/agents",
		Files:       []string{"agent/auth.json", "agent/auth-profiles.json", "agent/auth-state.json"},
		KeyPrefix:   "openclaw", // openclaw.go: key = "openclaw:" + name
	},
}

// stationDirs lists the station directories of a layout under home, sorted.
//
// Discovered by listing, never hardcoded: the fleet has 15 Hermes profiles and
// 12 OpenClaw agents with arbitrary names. Returns nil when the harness is not
// installed here — absence is not a finding.
func stationDirs(home string, layout StationCredentialLayout) (base string, names []string) {
	base = filepath.Join(home, layout.ProfilesDir)
	entries, err := os.ReadDir(base)
	if err != nil {
		return base, nil
	}
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // deterministic across runs
	return base, names
}

// CheckStationCredentials inspects per-station credential files for every
// composite harness found under home.
//
// This is the blind spot the shipped scanner had: it only ever looked at the
// top of a harness's home, so a Hermes profile with world-readable credentials
// passed.
func CheckStationCredentials(home string) []Finding {
	var out []Finding

	for _, layout := range StationCredentialLayouts {
		base, names := stationDirs(home, layout)
		for _, name := range names {
			station := layout.KeyPrefix + ":" + name
			for _, rel := range layout.Files {
				full := filepath.Join(base, name, rel)
				label := filepath.Join(layout.ProfilesDir, name, rel)
				out = append(out, checkOneCredentialFile(layout.Harness, station, label, full)...)
			}
		}
	}
	return out
}
