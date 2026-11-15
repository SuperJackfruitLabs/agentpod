// Package benchjournal supplies the private journal's bounded physical file and
// strict JSON primitives. It supplies no dispatch or cancellation authority.
package benchjournal

import (
	"bytes"
	"encoding/json"
	"errors"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

func PhysicalName(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }
func PhysicalDir(p string, private bool) error {
	if !PhysicalName(p) {
		return benchattempt.ErrInvalid
	}
	st, err := os.Lstat(p)
	if err != nil || !st.IsDir() || (private && st.Mode().Perm() != 0700) {
		return benchattempt.ErrInvalid
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || real != p {
		return benchattempt.ErrInvalid
	}
	return nil
}
func ReadFile(p string, max int, private bool) ([]byte, error) {
	st, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > int64(max) || (private && st.Mode().Perm() != 0600) {
		return nil, benchattempt.ErrInvalid
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, benchattempt.ErrInvalid
	}
	defer f.Close()
	now, err := f.Stat()
	if err != nil || !os.SameFile(st, now) {
		return nil, benchattempt.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(max)+1))
	if err != nil || len(raw) > max {
		return nil, benchattempt.ErrInvalid
	}
	return raw, nil
}
func SyncDir(p string) error {
	f, e := os.Open(p)
	if e != nil {
		return benchattempt.ErrInvalid
	}
	defer f.Close()
	if f.Sync() != nil {
		return benchattempt.ErrInvalid
	}
	return nil
}
func WriteAtomic(dir, name string, raw []byte) error {
	f, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return benchattempt.ErrInvalid
	}
	temp := f.Name()
	defer os.Remove(temp)
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	if ce := f.Close(); err == nil {
		err = ce
	}
	if err != nil {
		return benchattempt.ErrInvalid
	}
	if err = os.Rename(temp, filepath.Join(dir, name)); err != nil {
		return benchattempt.ErrInvalid
	}
	return SyncDir(dir)
}
func Decode(raw []byte, dst any) error {
	if !utf8.Valid(raw) {
		return benchattempt.ErrInvalid
	}
	// Reject duplicate keys recursively as well as unknown/null fields; ledger
	// files are private application state, not an extensible response protocol.
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := Unique(d, 0, false); err != nil {
		return benchattempt.ErrInvalid
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return benchattempt.ErrInvalid
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return benchattempt.ErrInvalid
	}
	return nil
}
func Unique(d *json.Decoder, depth int, allowNull bool) error {
	if depth > 128 {
		return benchattempt.ErrInvalid
	}
	tok, err := d.Token()
	if err != nil {
		return err
	}
	if tok == nil && !allowNull {
		return benchattempt.ErrInvalid
	}
	switch tok {
	case json.Delim('{'):
		seen := map[string]bool{}
		for d.More() {
			k, e := d.Token()
			if e != nil {
				return e
			}
			s, ok := k.(string)
			if !ok || seen[s] {
				return benchattempt.ErrInvalid
			}
			seen[s] = true
			if e = Unique(d, depth+1, allowNull); e != nil {
				return e
			}
		}
		_, err = d.Token()
	case json.Delim('['):
		for d.More() {
			if err = Unique(d, depth+1, allowNull); err != nil {
				return err
			}
		}
		_, err = d.Token()
	}
	return err
}
