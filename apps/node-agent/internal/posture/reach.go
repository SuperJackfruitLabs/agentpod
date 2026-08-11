package posture

import (
	"io/fs"
	"os"
	"path/filepath"
)

// Exposure says who, other than the owner, can actually read a path.
//
// "Actually" is the whole point: a file's own mode bits are necessary but not
// sufficient. A 644 file inside a 700 directory is unreachable by anyone else,
// and reporting it would be a false alarm — the failure mode this package's
// doc comment forbids as loudly as a false pass.
type Exposure struct {
	World bool
	Group bool
}

// Any reports whether anyone other than the owner can read the path.
func (e Exposure) Any() bool { return e.World || e.Group }

// EffectiveExposure reports who can genuinely reach and read path.
//
// Two conditions must both hold for a class (group or other):
//
//  1. the file itself grants read to that class, and
//  2. every ancestor directory grants execute (traverse) to that class.
//
// Verified against molt-bot 2026-08-11, where
// /root/.hermes/profiles/<name>/config.yaml is mode 644 under a 700 /root:
// world-readable by mode, unreachable in fact. Fifteen profiles, fifteen false
// criticals, on a correctly secured machine.
func EffectiveExposure(path string) (Exposure, error) {
	return exposureWalk(path, "/")
}

// exposureWalk is EffectiveExposure with a controllable stopping point.
//
// stopAt is the highest directory inspected, inclusive. Production always walks
// to "/", but tests cannot: macOS gives each user a private TMPDIR at mode 0700
// (/var/folders/…/T), so every path under t.TempDir() is genuinely unreachable
// and no fixture can produce a world-readable file there. Walking to "/" in a
// test would therefore pass on Linux CI and fail on a Mac — the worst kind of
// portability bug, because it only appears where nobody is looking.
func exposureWalk(path, stopAt string) (Exposure, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Exposure{}, err
	}

	perm := info.Mode().Perm()
	e := Exposure{
		World: perm&0o004 != 0,
		Group: perm&0o040 != 0,
	}
	if !e.Any() {
		return e, nil // owner-only: no ancestor can make it worse
	}

	abs, err := filepath.Abs(path)
	if err != nil {
		return Exposure{}, err
	}
	stop, err := filepath.Abs(stopAt)
	if err != nil {
		return Exposure{}, err
	}

	// Walk up. A single non-traversable ancestor is enough to make the path
	// unreachable for that class.
	dir := filepath.Dir(abs)
	for {
		di, derr := os.Stat(dir)
		if derr != nil {
			// An ancestor we cannot stat cannot be shown to be traversable.
			// Treating it as open would invent exposure we have not seen.
			return Exposure{}, derr
		}
		if !traversable(di.Mode().Perm(), 0o001) {
			e.World = false
		}
		if !traversable(di.Mode().Perm(), 0o010) {
			e.Group = false
		}
		if !e.Any() {
			return e, nil
		}

		if dir == stop {
			return e, nil // inspected the highest directory we were asked to
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return e, nil // reached the filesystem root
		}
		dir = parent
	}
}

func traversable(perm fs.FileMode, bit fs.FileMode) bool {
	return perm&bit != 0
}
