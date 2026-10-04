package descriptor

import "strings"

// yamlScalar reads `section.key` out of a YAML document as text, without a YAML
// parser and without re-encoding anything.
//
// This is the generalisation of what `hermesDescriptor.multiplexProfiles` did by
// hand, and it exists for the reason `hermeslive/config.go` records: a document
// is parsed to DECIDE and edited as LINES to DO, because re-encoding reflows an
// operator's file and loses their comments and ordering.
//
// Deliberately narrow. It reads one scalar under one top-level section, which is
// the shape every setting in the registry has. It does not read nested maps, and
// a list-valued key reports NOT FOUND rather than returning the empty remainder
// after the colon — "found, empty" and "not a scalar" must not look alike.
func yamlScalar(data []byte, section, key string) (string, bool) {
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
		// Nothing after the colon is a nested value (a list or a map), not a
		// scalar this reader can speak for.
		if v == "" {
			return "", false
		}
		return strings.Trim(v, `"'`), true
	}
	return "", false
}
