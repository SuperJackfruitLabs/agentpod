package benchdispatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"unicode/utf8"
)

func physicalName(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }
func physicalDir(p string, private bool) error {
	if !physicalName(p) {
		return ErrInvalid
	}
	st, err := os.Lstat(p)
	if err != nil || !st.IsDir() || (private && st.Mode().Perm() != 0700) {
		return ErrInvalid
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil || real != p {
		return ErrInvalid
	}
	return nil
}
func readFile(p string, max int, private bool) ([]byte, error) {
	st, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > int64(max) || (private && st.Mode().Perm() != 0600) {
		return nil, ErrInvalid
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, ErrInvalid
	}
	defer f.Close()
	now, err := f.Stat()
	if err != nil || !os.SameFile(st, now) {
		return nil, ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(f, int64(max)+1))
	if err != nil || len(raw) > max {
		return nil, ErrInvalid
	}
	return raw, nil
}
func syncDir(p string) error {
	f, e := os.Open(p)
	if e != nil {
		return ErrInvalid
	}
	defer f.Close()
	if f.Sync() != nil {
		return ErrInvalid
	}
	return nil
}
func writeAtomic(dir, name string, raw []byte) error {
	f, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return ErrInvalid
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
		return ErrInvalid
	}
	if err = os.Rename(temp, filepath.Join(dir, name)); err != nil {
		return ErrInvalid
	}
	return syncDir(dir)
}
func decode(raw []byte, dst any) error {
	if !utf8.Valid(raw) {
		return ErrInvalid
	}
	// Reject duplicate keys recursively as well as unknown/null fields; ledger
	// files are private application state, not an extensible response protocol.
	d := json.NewDecoder(bytes.NewReader(raw))
	if err := unique(d, 0, false); err != nil {
		return ErrInvalid
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	d = json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return ErrInvalid
	}
	return nil
}
func unique(d *json.Decoder, depth int, allowNull bool) error {
	if depth > 128 {
		return ErrInvalid
	}
	tok, err := d.Token()
	if err != nil {
		return err
	}
	if tok == nil && !allowNull {
		return ErrInvalid
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
				return ErrInvalid
			}
			seen[s] = true
			if e = unique(d, depth+1, allowNull); e != nil {
				return e
			}
		}
		_, err = d.Token()
	case json.Delim('['):
		for d.More() {
			if err = unique(d, depth+1, allowNull); err != nil {
				return err
			}
		}
		_, err = d.Token()
	}
	return err
}
