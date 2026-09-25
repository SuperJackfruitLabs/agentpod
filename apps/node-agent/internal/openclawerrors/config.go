package openclawerrors

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// OpenClaw's configuration belongs to OpenClaw and to its operator; apn edits
// two keys in it. A decode into Go maps and back would reorder every object in
// the file, so objects are handled here as ordered member lists and every
// value apn does not own is carried through as raw JSON, untouched.

type member struct {
	Key   string
	Value json.RawMessage
}

// parseObject reads a JSON object as ordered members. It refuses anything
// that is not strictly one JSON object, such as a hand-edited file with a
// comment in it: rewriting a file apn could not fully read would drop part of it.
func parseObject(raw []byte) ([]member, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return nil, fmt.Errorf("not JSON apn can edit safely: %w", err)
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not a JSON object")
	}
	var members []member
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, fmt.Errorf("not JSON apn can edit safely: %w", err)
		}
		key, ok := tok.(string)
		if !ok {
			return nil, errors.New("not JSON apn can edit safely")
		}
		var value json.RawMessage
		if err := dec.Decode(&value); err != nil {
			return nil, fmt.Errorf("not JSON apn can edit safely: %w", err)
		}
		members = append(members, member{Key: key, Value: value})
	}
	if _, err := dec.Token(); err != nil {
		return nil, fmt.Errorf("not JSON apn can edit safely: %w", err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("not JSON apn can edit safely: text after the object")
	}
	return members, nil
}

func encodeObject(members []member) json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, m := range members {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(m.Key)
		b.Write(k)
		b.WriteByte(':')
		b.Write(m.Value)
	}
	b.WriteByte('}')
	return b.Bytes()
}

func get(members []member, key string) (json.RawMessage, bool) {
	for _, m := range members {
		if m.Key == key {
			return m.Value, true
		}
	}
	return nil, false
}

func set(members []member, key string, value json.RawMessage) []member {
	for i, m := range members {
		if m.Key == key {
			members[i].Value = value
			return members
		}
	}
	return append(members, member{Key: key, Value: value})
}

func remove(members []member, key string) []member {
	out := members[:0]
	for _, m := range members {
		if m.Key != key {
			out = append(out, m)
		}
	}
	return out
}

// childObject reads members[key] as an object; absent is an empty one.
func childObject(members []member, key string) ([]member, error) {
	raw, ok := get(members, key)
	if !ok {
		return nil, nil
	}
	child, err := parseObject(raw)
	if err != nil {
		return nil, fmt.Errorf("%q: %w", key, err)
	}
	return child, nil
}

func enableConfig(raw []byte, pluginDir string) ([]byte, error) {
	root, err := parseObject(raw)
	if err != nil {
		return nil, err
	}
	plugins, err := childObject(root, "plugins")
	if err != nil {
		return nil, err
	}

	load, err := childObject(plugins, "load")
	if err != nil {
		return nil, err
	}
	var paths []json.RawMessage
	if rawPaths, ok := get(load, "paths"); ok {
		if err := json.Unmarshal(rawPaths, &paths); err != nil {
			return nil, fmt.Errorf("plugins.load.paths is not a list: %w", err)
		}
	}
	ours, _ := json.Marshal(pluginDir)
	found := false
	for _, p := range paths {
		var s string
		if json.Unmarshal(p, &s) == nil && s == pluginDir {
			found = true
		}
	}
	if !found {
		paths = append(paths, ours)
	}
	pathsJSON, _ := json.Marshal(paths)
	load = set(load, "paths", pathsJSON)
	plugins = set(plugins, "load", encodeObject(load))

	entries, err := childObject(plugins, "entries")
	if err != nil {
		return nil, err
	}
	entry, err := childObject(entries, Name)
	if err != nil {
		return nil, err
	}
	entry = set(entry, "enabled", json.RawMessage("true"))
	hooks, err := childObject(entry, "hooks")
	if err != nil {
		return nil, err
	}
	hooks = set(hooks, "allowConversationAccess", json.RawMessage("true"))
	entry = set(entry, "hooks", encodeObject(hooks))
	entries = set(entries, Name, encodeObject(entry))
	plugins = set(plugins, "entries", encodeObject(entries))

	return splicePlugins(raw, encodeObject(plugins))
}

func disableConfig(raw []byte, pluginDir string) ([]byte, error) {
	root, err := parseObject(raw)
	if err != nil {
		return nil, err
	}
	if _, ok := get(root, "plugins"); !ok {
		return raw, nil
	}
	plugins, err := childObject(root, "plugins")
	if err != nil {
		return nil, err
	}

	if load, err := childObject(plugins, "load"); err != nil {
		return nil, err
	} else if rawPaths, ok := get(load, "paths"); ok {
		var paths []json.RawMessage
		if err := json.Unmarshal(rawPaths, &paths); err != nil {
			return nil, fmt.Errorf("plugins.load.paths is not a list: %w", err)
		}
		kept := paths[:0]
		for _, p := range paths {
			var s string
			if json.Unmarshal(p, &s) == nil && s == pluginDir {
				continue
			}
			kept = append(kept, p)
		}
		if len(kept) == 0 {
			load = remove(load, "paths")
		} else {
			keptJSON, _ := json.Marshal(kept)
			load = set(load, "paths", keptJSON)
		}
		if len(load) == 0 {
			plugins = remove(plugins, "load")
		} else {
			plugins = set(plugins, "load", encodeObject(load))
		}
	}

	if entries, err := childObject(plugins, "entries"); err != nil {
		return nil, err
	} else if _, ok := get(entries, Name); ok {
		entries = remove(entries, Name)
		if len(entries) == 0 {
			plugins = remove(plugins, "entries")
		} else {
			plugins = set(plugins, "entries", encodeObject(entries))
		}
	}

	if len(plugins) == 0 {
		return splicePlugins(raw, nil)
	}
	return splicePlugins(raw, encodeObject(plugins))
}

// ─── Splicing ────────────────────────────────────────────────────────────────

// topSpan is where one top-level member sits in the original bytes.
type topSpan struct {
	key                            string
	keyStart, valueStart, valueEnd int
}

// scanTopLevel locates each top-level member's key and value in raw.
func scanTopLevel(raw []byte) ([]topSpan, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil { // {
		return nil, err
	}
	var spans []topSpan
	for dec.More() {
		before := int(dec.InputOffset())
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		keyStart := before + bytes.IndexByte(raw[before:], '"')
		afterKey := int(dec.InputOffset())
		colon := afterKey + bytes.IndexByte(raw[afterKey:], ':')
		valueStart := colon + 1
		for valueStart < len(raw) && isSpace(raw[valueStart]) {
			valueStart++
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
		spans = append(spans, topSpan{key: key, keyStart: keyStart, valueStart: valueStart, valueEnd: int(dec.InputOffset())})
	}
	return spans, nil
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// splicePlugins replaces the top-level "plugins" value in raw, adds it after
// the last member when absent, or removes the member when value is nil — and
// leaves every other byte of the file as it was.
func splicePlugins(raw []byte, value json.RawMessage) ([]byte, error) {
	spans, err := scanTopLevel(raw)
	if err != nil {
		return nil, fmt.Errorf("not JSON apn can edit safely: %w", err)
	}
	var indented []byte
	if value != nil {
		var b bytes.Buffer
		if err := json.Indent(&b, value, "  ", "  "); err != nil {
			return nil, err
		}
		indented = b.Bytes()
	}

	at := -1
	for i, sp := range spans {
		if sp.key == "plugins" {
			at = i
		}
	}
	var out bytes.Buffer
	switch {
	case at >= 0 && value != nil:
		sp := spans[at]
		out.Write(raw[:sp.valueStart])
		out.Write(indented)
		out.Write(raw[sp.valueEnd:])
	case at >= 0: // remove the member and the comma that joined it
		sp := spans[at]
		if at > 0 {
			out.Write(raw[:spans[at-1].valueEnd])
			out.Write(raw[sp.valueEnd:])
		} else if len(spans) > 1 {
			out.Write(raw[:sp.keyStart])
			out.Write(raw[spans[1].keyStart:])
		} else {
			out.Write(raw[:sp.keyStart])
			rest := raw[sp.valueEnd:]
			out.Write(bytes.TrimLeft(rest, " \t\r\n"))
		}
	case value != nil && len(spans) > 0: // append after the last member
		last := spans[len(spans)-1]
		out.Write(raw[:last.valueEnd])
		out.WriteString(",\n  \"plugins\": ")
		out.Write(indented)
		out.Write(raw[last.valueEnd:])
	case value != nil: // an empty object
		open := bytes.IndexByte(raw, '{')
		out.Write(raw[:open+1])
		out.WriteString("\n  \"plugins\": ")
		out.Write(indented)
		out.WriteString("\n")
		out.Write(bytes.TrimLeft(raw[open+1:], " \t\r\n"))
	default:
		return raw, nil
	}
	return out.Bytes(), nil
}

// Diff lists the lines that differ between before and after, as "  + line"
// and "  - line", by longest common subsequence: a review must show the change
// being made and nothing else, in a file that also holds tokens.
func Diff(before, after string) string {
	a, b := strings.Split(before, "\n"), strings.Split(after, "\n")
	lcs := make([][]int, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	var out strings.Builder
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			i, j = i+1, j+1
		case j < len(b) && (i == len(a) || lcs[i][j+1] >= lcs[i+1][j]):
			fmt.Fprintf(&out, "  + %s\n", b[j])
			j++
		default:
			fmt.Fprintf(&out, "  - %s\n", a[i])
			i++
		}
	}
	return out.String()
}
