package descriptor

import "strings"

// yamlValueState is what a document had at `section.key`, as three outcomes
// rather than two.
//
// Two outcomes were not enough. A reader that can only say "here is a scalar" or
// "nothing found" makes a PRESENT key holding a list indistinguishable from an
// absent one, and a caller that reports the second as "the key is not in the
// document" then writes a false sentence about a document that plainly contains
// it. The third outcome is the whole point: present, and not something this
// reader can speak for.
type yamlValueState int

const (
	// yamlAbsent: no such key under that section (or no such section).
	yamlAbsent yamlValueState = iota
	// yamlScalarValue: the key is there and holds a scalar, returned as text.
	yamlScalarValue
	// yamlNotScalar: the key is there and holds a list or a nested map.
	yamlNotScalar
)

// yamlValue reads `section.key` out of a YAML document as text, without a YAML
// parser and without re-encoding anything.
//
// This is the generalisation of what `hermesDescriptor.multiplexProfiles` did by
// hand, and it exists for the reason `hermeslive/config.go` records: a document
// is parsed to DECIDE and edited as LINES to DO, because re-encoding reflows an
// operator's file and loses their comments and ordering.
//
// Deliberately narrow. It reads one scalar under one top-level section, which is
// the shape almost every setting in the registry has. It does not read nested
// maps or lists — it REPORTS them, as `yamlNotScalar`, so "found, empty",
// "not a scalar" and "not there" are three different answers rather than two.
func yamlValue(data []byte, section, key string) (string, yamlValueState) {
	inSection := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		// An unindented line opens a new top-level section, closing any previous one.
		if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
			inSection = strings.TrimSpace(strings.SplitN(line, ":", 2)[0]) == section
			continue
		}
		if !inSection || !strings.HasPrefix(trimmed, key+":") {
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(trimmed, key+":"))
		if i := strings.Index(v, "#"); i >= 0 {
			v = strings.TrimSpace(v[:i])
		}
		// Nothing after the colon is a nested value — a block list or a block
		// map — on the lines below. Present, not a scalar.
		if v == "" {
			return "", yamlNotScalar
		}
		// A flow collection on the same line: `[ls, cat]`, `{a: 1}`. Returning
		// its raw text as a scalar would have it compared as a string against a
		// declared list and report drift forever, which is why it is checked
		// BEFORE quotes are trimmed — a quoted `"[x]"` really is a scalar.
		if v[0] == '[' || v[0] == '{' {
			return "", yamlNotScalar
		}
		return strings.Trim(v, `"'`), yamlScalarValue
	}
	return "", yamlAbsent
}

// yamlScalar is the two-outcome view of yamlValue, for callers that only ever
// want a scalar and treat everything else as "no". `multiplexProfiles` is one:
// `gateway.multiplex_profiles` is a boolean or it is nothing.
func yamlScalar(data []byte, section, key string) (string, bool) {
	v, state := yamlValue(data, section, key)
	return v, state == yamlScalarValue
}
