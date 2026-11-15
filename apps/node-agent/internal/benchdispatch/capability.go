package benchdispatch

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
)

var capabilityPattern = regexp.MustCompile(`^([a-f0-9]{32}|[a-f0-9]{48})$`)

// Capability is a private SuperBench continuation token, NEVER a reporter JWT.
// It refuses ordinary JSON/text serialization and redacts formatted diagnostics.
// The explicit Use callback exists only for exact-owner reconciliation requests.
type Capability struct{ value string }

func NewCapability(value string) (Capability, error) {
	if !capabilityPattern.MatchString(value) {
		return Capability{}, ErrInvalid
	}
	return Capability{value: value}, nil
}
func (Capability) String() string               { return "[private capability]" }
func (Capability) GoString() string             { return "[private capability]" }
func (Capability) MarshalJSON() ([]byte, error) { return nil, ErrInvalid }
func (Capability) MarshalText() ([]byte, error) { return nil, ErrInvalid }
func (c Capability) Use(fn func(string) error) error {
	if fn == nil || !capabilityPattern.MatchString(c.value) {
		return ErrInvalid
	}
	if fn(c.value) != nil {
		return ErrVerify
	}
	return nil
}

func (s Store) RetainCapability(ctx context.Context, p Plan, c Capability) error {
	if !capabilityPattern.MatchString(c.value) {
		return ErrInvalid
	}
	return s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if doc.Active != planID(p) || (r.Phase != "pending" && r.Phase != "uncertain") {
			return false, ErrOwner
		}
		name := capabilityName(p)
		path := filepath.Join(s.Root, name)
		old, e := readFile(path, 48, true)
		if e == nil {
			if subtle.ConstantTimeCompare(old, []byte(c.value)) != 1 {
				return false, ErrConflict
			}
			return false, nil
		}
		if !errors.Is(e, os.ErrNotExist) {
			return false, ErrInvalid
		}
		// Publish a fully fsynced private token file with create-only hard link.
		// Partial writes remain temporary and can never be loaded as a capability.
		f, e := os.CreateTemp(s.Root, ".capability-")
		if e != nil {
			return false, ErrInvalid
		}
		temp := f.Name()
		defer os.Remove(temp)
		if _, e = f.WriteString(c.value); e == nil {
			e = f.Sync()
		}
		if ce := f.Close(); e == nil {
			e = ce
		}
		if e != nil {
			return false, ErrInvalid
		}
		if os.Link(temp, path) != nil || syncDir(s.Root) != nil {
			return false, ErrInvalid
		}
		return false, nil
	})
}
func (s Store) Capability(ctx context.Context, p Plan) (Capability, error) {
	var c Capability
	err := s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if doc.Active != planID(p) || (r.Phase != "pending" && r.Phase != "uncertain") {
			return false, ErrOwner
		}
		raw, e := readFile(filepath.Join(s.Root, capabilityName(p)), 48, true)
		if e != nil {
			return false, ErrInvalid
		}
		c, e = NewCapability(string(raw))
		return false, e
	})
	return c, err
}

// Keep the serialization refusal visible to maintainers adding projections.
var _ json.Marshaler = Capability{}

func capabilityName(p Plan) string {
	return digest([]byte(p.BenchKey)) + "-" + planID(p) + ".capability"
}
