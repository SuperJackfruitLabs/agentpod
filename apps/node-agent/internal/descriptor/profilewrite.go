package descriptor

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
)

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

// writers holds every registered ProfileWriter, keyed by harness name.
var writers = map[string]ProfileWriter{}

// registerWriter adds w to the registry, keyed by w.Harness().
func registerWriter(w ProfileWriter) {
	writers[w.Harness()] = w
}

func init() {
	registerWriter(hermesEnvWriter{})
}

// WriterFor returns the registered ProfileWriter for harness, if any.
func WriterFor(harness string) (ProfileWriter, bool) {
	w, ok := writers[harness]
	return w, ok
}

// AllWriters returns every registered writer, sorted by harness name for a
// deterministic order. The conformance suite ranges over this, so an adapter
// registered in a later slice is covered without the suite being edited.
func AllWriters() []ProfileWriter {
	names := make([]string, 0, len(writers))
	for name := range writers {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make([]ProfileWriter, 0, len(names))
	for _, name := range names {
		out = append(out, writers[name])
	}
	return out
}

// atomicWriteFile writes data to path via a temp file created alongside it,
// chmod'd to perm before anything is written, then renamed into place. A
// process that dies mid-write leaves the temp file — never a half-written
// profile — and the temp file never carries a wider mode than the file it
// becomes, which matters here because data is routinely a credential.
func atomicWriteFile(path string, data []byte, perm fs.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-"+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()

	// Clean up the temp file on any failure path; a successful rename leaves
	// nothing at tmpPath to remove.
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmpPath)
		}
	}()

	if err = tmp.Chmod(perm); err != nil {
		return err
	}
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmpPath, path); err != nil {
		return err
	}
	return nil
}
