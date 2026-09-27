package hermeslive

import (
	"errors"
	"fmt"
	"reflect"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ErrConflict is a profile configuration this installer will not edit: an
// unexpected shape, or one that changed since it was reviewed.
var ErrConflict = errors.New("hermes-live: conflict")

// ErrDisabledByOperator is plugins.disabled naming the plugin. That is the
// operator's explicit choice, and enabling does not override it.
var ErrDisabledByOperator = errors.New("hermes-live: the plugin is listed in plugins.disabled")

// Enabling touches exactly two keys, and nothing else in the document:
//
//	plugins:
//	  enabled: [..., agentpod-live]
//	  stream_reasoning_deltas: true   # reasoning deltas reach plugins only with this
//
// The document is parsed to decide what to do and edited as lines to do it, as
// `hermes-skills register` does: re-encoding would reflow an operator's file.
// Hermes's own `plugins entries` and `_config_version` are never touched.

// ConfigChange records what enabling changed, so that disabling can undo
// exactly that and no more.
type ConfigChange struct {
	PluginsCreated    bool   `json:"pluginsCreated"`
	EnabledKeyCreated bool   `json:"enabledKeyCreated"`
	EnabledAdded      bool   `json:"enabledAdded"`
	StreamPrevious    string `json:"streamPrevious"` // "absent", "true" or "false"
}

func planEnableConfig(current []byte) ([]byte, ConfigChange, error) {
	change := ConfigChange{StreamPrevious: "absent"}
	root, err := mapping(current)
	if err != nil {
		return nil, change, err
	}
	pluginsKey, plugins := child(root, "plugins")
	if plugins != nil && plugins.Kind != yaml.MappingNode && !isEmptyValue(plugins) {
		return nil, change, fmt.Errorf("%w: plugins is not a mapping", ErrConflict)
	}
	if plugins != nil && plugins.Kind == yaml.MappingNode {
		if _, disabled := child(plugins, "disabled"); disabled != nil && listHas(disabled, Name) {
			return nil, change, ErrDisabledByOperator
		}
	}
	lines := splitLines(current)
	if plugins == nil {
		change = ConfigChange{PluginsCreated: true, EnabledKeyCreated: true, EnabledAdded: true, StreamPrevious: "absent"}
		edited := appendBlock(current, "plugins:\n  enabled:\n    - "+Name+"\n  stream_reasoning_deltas: true\n")
		return edited, change, verifyEnable(current, edited)
	}
	if plugins.Kind != yaml.MappingNode {
		// `plugins:` with no value: only a bare key line is extended in place.
		if strings.TrimSpace(lineAt(lines, pluginsKey.Line)) != "plugins:" {
			return nil, change, fmt.Errorf("%w: plugins has a value this installer cannot extend", ErrConflict)
		}
		indent := leadingSpace(lineAt(lines, pluginsKey.Line))
		change = ConfigChange{EnabledKeyCreated: true, EnabledAdded: true, StreamPrevious: "absent"}
		edited := insertAfter(lines, pluginsKey.Line, indent+"  enabled:", indent+"    - "+Name, indent+"  stream_reasoning_deltas: true")
		return edited, change, verifyEnable(current, edited)
	}

	// plugins.enabled
	edited := current
	enabledKey, enabled := child(plugins, "enabled")
	switch {
	case enabled != nil && listHas(enabled, Name):
	case enabled == nil:
		indent := leadingSpace(lineAt(lines, pluginsKey.Line))
		edited = insertAfter(lines, pluginsKey.Line, indent+"  enabled:", indent+"    - "+Name)
		change.EnabledKeyCreated, change.EnabledAdded = true, true
	default:
		edited, err = addToList(lines, enabledKey, enabled, Name)
		if err != nil {
			return nil, change, err
		}
		change.EnabledAdded = true
	}

	// plugins.stream_reasoning_deltas, located again in the edited document.
	root, err = mapping(edited)
	if err != nil {
		return nil, change, err
	}
	pluginsKey, plugins = child(root, "plugins")
	lines = splitLines(edited)
	streamKey, stream := child(plugins, "stream_reasoning_deltas")
	switch {
	case stream == nil:
		indent := leadingSpace(lineAt(lines, pluginsKey.Line))
		edited = insertAfter(lines, pluginsKey.Line, indent+"  stream_reasoning_deltas: true")
	case isBool(stream, true):
		change.StreamPrevious = "true"
	case isBool(stream, false):
		change.StreamPrevious = "false"
		edited, err = replaceScalar(lines, streamKey, stream, "true")
		if err != nil {
			return nil, change, err
		}
	default:
		return nil, change, fmt.Errorf("%w: plugins.stream_reasoning_deltas is not a boolean", ErrConflict)
	}
	if string(edited) == string(current) {
		return current, change, nil
	}
	return edited, change, verifyEnable(current, edited)
}

// planDisableConfig undoes a recorded change on a document that may have been
// edited since, touching only what enabling added.
func planDisableConfig(current []byte, change ConfigChange) ([]byte, error) {
	edited := current
	root, err := mapping(edited)
	if err != nil {
		return nil, err
	}
	pluginsKey, plugins := child(root, "plugins")
	if plugins == nil || plugins.Kind != yaml.MappingNode {
		// Nothing of ours is left to remove.
		return current, nil
	}
	if change.EnabledAdded {
		if enabledKey, enabled := child(plugins, "enabled"); enabled != nil && listHas(enabled, Name) {
			edited, err = removeFromList(splitLines(edited), enabledKey, enabled, Name, change.EnabledKeyCreated)
			if err != nil {
				return nil, err
			}
		}
	}
	root, err = mapping(edited)
	if err != nil {
		return nil, err
	}
	pluginsKey, plugins = child(root, "plugins")
	if streamKey, stream := child(plugins, "stream_reasoning_deltas"); stream != nil && isBool(stream, true) {
		switch change.StreamPrevious {
		case "absent":
			edited = removeLines(splitLines(edited), streamKey.Line, streamKey.Line)
		case "false":
			if edited, err = replaceScalar(splitLines(edited), streamKey, stream, "false"); err != nil {
				return nil, err
			}
		}
	}
	if change.PluginsCreated {
		root, err = mapping(edited)
		if err != nil {
			return nil, err
		}
		if pluginsKey, plugins = child(root, "plugins"); plugins != nil && (isEmptyValue(plugins) || (plugins.Kind == yaml.MappingNode && len(plugins.Content) == 0)) {
			edited = removeLines(splitLines(edited), pluginsKey.Line, pluginsKey.Line)
		}
	}
	if string(edited) == string(current) {
		return current, nil
	}
	return edited, verifyDisable(current, edited, change)
}

// ---- verification -----------------------------------------------------------

// verifyEnable reparses the edit: plugins.enabled gained the plugin,
// stream_reasoning_deltas is true, and every other setting is unchanged.
func verifyEnable(before, after []byte) error {
	b, a, err := parsePair(before, after)
	if err != nil {
		return err
	}
	if !listHasValue(pluginsValue(a, "enabled"), Name) || pluginsValue(a, "stream_reasoning_deltas") != true {
		return fmt.Errorf("%w: the edit did not enable the plugin as reviewed", ErrConflict)
	}
	wantEnabled := append(listStrings(pluginsValue(b, "enabled")), Name)
	if !listHasValue(pluginsValue(b, "enabled"), Name) && !reflect.DeepEqual(listStrings(pluginsValue(a, "enabled")), wantEnabled) {
		return fmt.Errorf("%w: plugins.enabled changed beyond adding %s", ErrConflict, Name)
	}
	return sameOutsideOurKeys(b, a)
}

// verifyDisable reparses the reversal: the plugin left plugins.enabled only if
// enabling added it, the stream flag is back to what it was, and nothing else
// moved.
func verifyDisable(before, after []byte, change ConfigChange) error {
	b, a, err := parsePair(before, after)
	if err != nil {
		return err
	}
	if change.EnabledAdded && listHasValue(pluginsValue(a, "enabled"), Name) {
		return fmt.Errorf("%w: the reversal left %s enabled", ErrConflict, Name)
	}
	switch change.StreamPrevious {
	case "absent":
		if pluginsValue(a, "stream_reasoning_deltas") != nil {
			return fmt.Errorf("%w: the reversal left stream_reasoning_deltas set", ErrConflict)
		}
	case "false":
		if pluginsValue(a, "stream_reasoning_deltas") != false {
			return fmt.Errorf("%w: the reversal did not restore stream_reasoning_deltas: false", ErrConflict)
		}
	}
	return sameOutsideOurKeys(b, a)
}

func parsePair(before, after []byte) (map[string]any, map[string]any, error) {
	var b, a map[string]any
	if err := yaml.Unmarshal(before, &b); err != nil {
		return nil, nil, err
	}
	if err := yaml.Unmarshal(after, &a); err != nil {
		return nil, nil, fmt.Errorf("hermes-live: the proposed profile configuration is not valid YAML: %w", err)
	}
	if b == nil {
		b = map[string]any{}
	}
	if a == nil {
		a = map[string]any{}
	}
	return b, a, nil
}

func pluginsValue(doc map[string]any, key string) any {
	plugins, _ := doc["plugins"].(map[string]any)
	return plugins[key]
}

func listStrings(v any) []string {
	raw, _ := v.([]any)
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

func listHasValue(v any, want string) bool {
	for _, item := range listStrings(v) {
		if item == want {
			return true
		}
	}
	return false
}

// sameOutsideOurKeys compares the two documents with plugins.enabled's entry
// for this plugin and plugins.stream_reasoning_deltas set aside.
func sameOutsideOurKeys(before, after map[string]any) error {
	strip := func(doc map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range doc {
			out[k] = v
		}
		if v, present := doc["plugins"]; present && v == nil {
			// A bare `plugins:` key is the same absence of settings as no key.
			delete(out, "plugins")
			return out
		}
		plugins, ok := doc["plugins"].(map[string]any)
		if !ok {
			return out
		}
		copied := map[string]any{}
		for k, v := range plugins {
			copied[k] = v
		}
		delete(copied, "stream_reasoning_deltas")
		if enabled, ok := copied["enabled"]; ok {
			kept := []string{}
			for _, item := range listStrings(enabled) {
				if item != Name {
					kept = append(kept, item)
				}
			}
			if len(kept) == 0 {
				delete(copied, "enabled")
			} else {
				copied["enabled"] = kept
			}
		}
		if len(copied) == 0 {
			delete(out, "plugins")
		} else {
			out["plugins"] = copied
		}
		return out
	}
	if !reflect.DeepEqual(strip(before), strip(after)) {
		return fmt.Errorf("%w: the edit changed a setting outside plugins.enabled and plugins.stream_reasoning_deltas", ErrConflict)
	}
	return nil
}

// ---- document and line helpers ---------------------------------------------

func mapping(data []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("hermes-live: profile configuration is not valid YAML: %w", err)
	}
	if doc.Kind == 0 && len(strings.TrimSpace(string(data))) == 0 {
		return &yaml.Node{Kind: yaml.MappingNode}, nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%w: profile configuration is not a mapping", ErrConflict)
	}
	return doc.Content[0], nil
}

func child(parent *yaml.Node, key string) (*yaml.Node, *yaml.Node) {
	if parent == nil || parent.Kind != yaml.MappingNode {
		return nil, nil
	}
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			return parent.Content[i], parent.Content[i+1]
		}
	}
	return nil, nil
}

func isEmptyValue(n *yaml.Node) bool {
	return n.Kind == yaml.ScalarNode && (n.Tag == "!!null" || n.Value == "")
}

func isBool(n *yaml.Node, want bool) bool {
	if n.Kind != yaml.ScalarNode || n.Tag != "!!bool" {
		return false
	}
	return strings.EqualFold(n.Value, fmt.Sprint(want))
}

func listHas(list *yaml.Node, want string) bool {
	if list.Kind != yaml.SequenceNode {
		return false
	}
	for _, item := range list.Content {
		if item.Kind == yaml.ScalarNode && item.Value == want {
			return true
		}
	}
	return false
}

func addToList(lines []string, key, list *yaml.Node, entry string) ([]byte, error) {
	switch {
	case isEmptyValue(list):
		indent := leadingSpace(lineAt(lines, key.Line))
		return insertAfter(lines, key.Line, indent+"  - "+entry), nil
	case list.Kind != yaml.SequenceNode:
		return nil, fmt.Errorf("%w: plugins.enabled is not a list", ErrConflict)
	case list.Style&yaml.FlowStyle != 0:
		line := lineAt(lines, list.Line)
		open, close := strings.Index(line, "["), strings.LastIndex(line, "]")
		if open < 0 || close < open {
			return nil, fmt.Errorf("%w: plugins.enabled is an inline list this installer cannot extend", ErrConflict)
		}
		if strings.TrimSpace(line[open+1:close]) == "" {
			lines[list.Line-1] = line[:close] + entry + line[close:]
		} else {
			lines[list.Line-1] = line[:close] + ", " + entry + line[close:]
		}
		return joinLines(lines), nil
	default:
		for _, item := range list.Content {
			if item.Kind != yaml.ScalarNode {
				return nil, fmt.Errorf("%w: plugins.enabled holds a non-scalar entry", ErrConflict)
			}
		}
		last := list.Content[len(list.Content)-1]
		item := lineAt(lines, last.Line)
		dash := strings.Index(item, "- ")
		if dash < 0 || strings.TrimSpace(item[:dash]) != "" {
			return nil, fmt.Errorf("%w: plugins.enabled is not a block list this installer can extend", ErrConflict)
		}
		return insertAfter(lines, last.Line, item[:dash]+"- "+entry), nil
	}
}

func removeFromList(lines []string, key, list *yaml.Node, entry string, removeKeyIfEmpty bool) ([]byte, error) {
	remaining := 0
	for _, item := range list.Content {
		if item.Value != entry {
			remaining++
		}
	}
	if list.Style&yaml.FlowStyle != 0 {
		line := lineAt(lines, list.Line)
		open, close := strings.Index(line, "["), strings.LastIndex(line, "]")
		if open < 0 || close < open || list.Line != key.Line {
			return nil, fmt.Errorf("%w: plugins.enabled is an inline list this installer cannot edit", ErrConflict)
		}
		if remaining == 0 && removeKeyIfEmpty {
			return removeLines(lines, key.Line, key.Line), nil
		}
		kept := []string{}
		for _, item := range list.Content {
			if item.Value != entry {
				kept = append(kept, item.Value)
			}
		}
		lines[list.Line-1] = line[:open+1] + strings.Join(kept, ", ") + line[close:]
		return joinLines(lines), nil
	}
	for _, item := range list.Content {
		if item.Value != entry {
			continue
		}
		text := lineAt(lines, item.Line)
		if !strings.Contains(text, "- ") || !strings.Contains(text, entry) {
			return nil, fmt.Errorf("%w: the plugins.enabled entry is not on a line of its own", ErrConflict)
		}
		if remaining == 0 && removeKeyIfEmpty {
			return removeLines(lines, key.Line, item.Line), nil
		}
		if remaining == 0 {
			// Keep the key the operator had; an empty list, not a null.
			keyLine := lineAt(lines, key.Line)
			lines[key.Line-1] = strings.TrimRight(keyLine, " ") + " []"
			return removeLines(lines, item.Line, item.Line), nil
		}
		return removeLines(lines, item.Line, item.Line), nil
	}
	return nil, fmt.Errorf("%w: %s was not found in plugins.enabled", ErrConflict, entry)
}

// replaceScalar swaps a scalar's value on its own line, keeping the key text
// and any trailing comment.
func replaceScalar(lines []string, key, value *yaml.Node, replacement string) ([]byte, error) {
	if key.Line != value.Line || value.Column < 1 {
		return nil, fmt.Errorf("%w: %s is not a one-line setting", ErrConflict, key.Value)
	}
	line := lineAt(lines, value.Line)
	start := value.Column - 1
	if start+len(value.Value) > len(line) || line[start:start+len(value.Value)] != value.Value {
		return nil, fmt.Errorf("%w: %s is not written the way it parses", ErrConflict, key.Value)
	}
	lines[value.Line-1] = line[:start] + replacement + line[start+len(value.Value):]
	return joinLines(lines), nil
}

func splitLines(data []byte) []string { return strings.Split(string(data), "\n") }

func joinLines(lines []string) []byte { return []byte(strings.Join(lines, "\n")) }

func lineAt(lines []string, n int) string {
	if n < 1 || n > len(lines) {
		return ""
	}
	return lines[n-1]
}

func leadingSpace(line string) string { return line[:len(line)-len(strings.TrimLeft(line, " \t"))] }

func insertAfter(lines []string, after int, added ...string) []byte {
	out := make([]string, 0, len(lines)+len(added))
	out = append(out, lines[:after]...)
	out = append(out, added...)
	out = append(out, lines[after:]...)
	return joinLines(out)
}

// removeLines removes lines first..last, inclusive, 1-based.
func removeLines(lines []string, first, last int) []byte {
	out := make([]string, 0, len(lines))
	out = append(out, lines[:first-1]...)
	return joinLines(append(out, lines[last:]...))
}

func appendBlock(current []byte, block string) []byte {
	text := string(current)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return []byte(text + block)
}
