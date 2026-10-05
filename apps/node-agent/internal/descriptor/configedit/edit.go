// Package configedit reads and writes one setting at a time in a harness's
// own YAML configuration file, addressed by a dot-separated key path.
//
// It is the generalised version of `apps/node-agent/internal/hermeslive/config.go`,
// which does exactly this for a fixed pair of `plugins.*` keys. That file is the
// reviewed precedent for every move here: a document is parsed (as a
// `yaml.Node`) to DECIDE what to do, and edited as LINES to DO it, because
// re-encoding a YAML document reflows an operator's file — their comments,
// key order and indentation are theirs, not ours to rewrite.
//
// This package does not touch Hermes, or any other harness, itself. It is a
// pure byte-in, byte-out editor of a document a caller already read and will
// itself write back.
package configedit

import (
	"errors"
	"fmt"
	"reflect"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ErrShapeUnexpected is returned when a key path walks into (or through) a
// node whose shape this editor does not know how to read or extend: a parent
// expected to be a mapping that is a list instead, a list expected to be a
// block sequence that is something this editor cannot safely rewrite, and so
// on. It is always wrapped with a sentence naming which key and what shape
// was found.
var ErrShapeUnexpected = errors.New("configedit: shape unexpected")

// Read walks a dot-separated keyPath through mapping nodes and reports what is
// there.
//
// A scalar decodes to its Go value (string, int, bool, ...). A sequence
// decodes to []any. A mapping at the leaf is present, with the mapping
// decoded to map[string]any as its value. A key that is not there, or whose
// parent is not there, is `present=false` with no error — but a document that
// cannot be parsed at all is an error, with present always false: an
// unreadable document must never look like a document whose key is absent.
func Read(doc []byte, keyPath string) (value any, present bool, err error) {
	root, err := mapping(doc)
	if err != nil {
		return nil, false, err
	}
	_, node, ok := walk(root, keyPath)
	if !ok {
		return nil, false, nil
	}
	var v any
	if err := node.Decode(&v); err != nil {
		return nil, false, fmt.Errorf("configedit: %s did not decode: %w", keyPath, err)
	}
	return v, true, nil
}

// SetScalar writes v as the scalar value of keyPath, replacing only the value
// portion of its line — leading whitespace and any trailing comment survive —
// and returns "modify" if the key already held a (different) scalar value, or
// "create" if the line was inserted under its parent.
//
// A parent that exists but is not a mapping, or a key that exists but does
// not hold a scalar on a line of its own, is ErrShapeUnexpected.
func SetScalar(doc []byte, keyPath string, v any) ([]byte, string, error) {
	parts := strings.Split(keyPath, ".")
	parent, err := walkMappingParents(doc, parts[:len(parts)-1])
	if err != nil {
		return nil, "", err
	}
	leaf := parts[len(parts)-1]
	replacement := scalarText(v)

	lines := splitLines(doc)
	parentKey, parentNode := parent.key, parent.node
	key, node := child(parentNode, leaf)
	if node == nil {
		indent := parentIndent(lines, parentKey, parentNode)
		edited := insertAfter(lines, insertionLine(parentKey, parentNode), indent+leaf+": "+replacement)
		return edited, "create", nil
	}
	if node.Kind != yaml.ScalarNode {
		return nil, "", fmt.Errorf("%w: %s is not a scalar", ErrShapeUnexpected, keyPath)
	}
	edited, err := replaceScalar(lines, key, node, replacement)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s: %v", ErrShapeUnexpected, keyPath, err)
	}
	return edited, "modify", nil
}

// AppendToList adds the items in items that are not already present
// (compared as strings) to the block list at keyPath, at the list's existing
// indentation. It never removes or reorders an entry already there. A missing
// key creates the list holding exactly the new items. A key present but not a
// sequence is ErrShapeUnexpected.
//
// It returns "append" if anything was written (including creating the key),
// or "noop" if every item was already present, plus the subset of items that
// was actually added, in the order given.
func AppendToList(doc []byte, keyPath string, items []string) ([]byte, string, []string, error) {
	parts := strings.Split(keyPath, ".")
	parent, err := walkMappingParents(doc, parts[:len(parts)-1])
	if err != nil {
		return nil, "", nil, err
	}
	leaf := parts[len(parts)-1]
	lines := splitLines(doc)
	parentKey, parentNode := parent.key, parent.node
	key, list := child(parentNode, leaf)

	if list == nil {
		added := dedupe(items)
		if len(added) == 0 {
			return doc, "noop", nil, nil
		}
		indent := parentIndent(lines, parentKey, parentNode)
		block := []string{indent + leaf + ":"}
		for _, item := range added {
			block = append(block, indent+"  - "+item)
		}
		edited := insertAfter(lines, insertionLine(parentKey, parentNode), block...)
		return edited, "append", added, nil
	}
	if isEmptyValue(list) {
		added := dedupe(items)
		if len(added) == 0 {
			return doc, "noop", nil, nil
		}
		indent := leadingSpace(lineAt(lines, key.Line))
		block := make([]string, 0, len(added))
		for _, item := range added {
			block = append(block, indent+"  - "+item)
		}
		edited := insertAfter(lines, key.Line, block...)
		return edited, "append", added, nil
	}
	if list.Kind != yaml.SequenceNode {
		return nil, "", nil, fmt.Errorf("%w: %s is not a list", ErrShapeUnexpected, keyPath)
	}

	existing := map[string]bool{}
	for _, it := range list.Content {
		if it.Kind != yaml.ScalarNode {
			return nil, "", nil, fmt.Errorf("%w: %s holds a non-scalar entry", ErrShapeUnexpected, keyPath)
		}
		existing[it.Value] = true
	}
	var toAdd []string
	for _, item := range items {
		if !existing[item] {
			existing[item] = true
			toAdd = append(toAdd, item)
		}
	}
	if len(toAdd) == 0 {
		return doc, "noop", nil, nil
	}

	if list.Style&yaml.FlowStyle != 0 {
		line := lineAt(lines, list.Line)
		open, closeIdx := strings.Index(line, "["), strings.LastIndex(line, "]")
		if open < 0 || closeIdx < open {
			return nil, "", nil, fmt.Errorf("%w: %s is an inline list this editor cannot extend", ErrShapeUnexpected, keyPath)
		}
		insertion := strings.Join(toAdd, ", ")
		if strings.TrimSpace(line[open+1:closeIdx]) != "" {
			insertion = ", " + insertion
		}
		lines[list.Line-1] = line[:closeIdx] + insertion + line[closeIdx:]
		return joinLines(lines), "append", toAdd, nil
	}

	last := list.Content[len(list.Content)-1]
	lastLine := lineAt(lines, last.Line)
	dash := strings.Index(lastLine, "- ")
	if dash < 0 || strings.TrimSpace(lastLine[:dash]) != "" {
		return nil, "", nil, fmt.Errorf("%w: %s is not a block list this editor can extend", ErrShapeUnexpected, keyPath)
	}
	block := make([]string, 0, len(toAdd))
	for _, item := range toAdd {
		block = append(block, lastLine[:dash]+"- "+item)
	}
	edited := insertAfter(lines, last.Line, block...)
	return edited, "append", toAdd, nil
}

// SameOutsideKeys reports whether before and after agree on everything except
// the given keyPaths, each of which is removed from both documents before
// comparing, and the items named in additive (one entry's added items,
// keyed by that same keyPath) which are removed only from the AFTER
// document — so an operator's own entries in an additive-only list are still
// compared and must be unchanged, while the exact items an apply declares it
// added are not held against it.
func SameOutsideKeys(before, after []byte, keyPaths []string, additive map[string][]string) error {
	var b, a map[string]any
	if err := yaml.Unmarshal(before, &b); err != nil {
		return fmt.Errorf("configedit: before is not valid YAML: %w", err)
	}
	if err := yaml.Unmarshal(after, &a); err != nil {
		return fmt.Errorf("configedit: after is not valid YAML: %w", err)
	}
	if b == nil {
		b = map[string]any{}
	}
	if a == nil {
		a = map[string]any{}
	}
	for _, kp := range keyPaths {
		if added, ok := additive[kp]; ok {
			// Remove only the items this apply says it added, from `after`.
			// The key stays in BOTH documents, so the operator's remaining
			// entries are compared and must still be unchanged.
			removeListItems(a, kp, added)
			continue
		}
		deleteKeyPath(b, kp)
		deleteKeyPath(a, kp)
	}
	if !reflect.DeepEqual(b, a) {
		return fmt.Errorf("configedit: the edit changed something outside %v", keyPaths)
	}
	return nil
}

// ---- key-path walking -------------------------------------------------------

func walk(root *yaml.Node, keyPath string) (key, value *yaml.Node, ok bool) {
	node := root
	parts := strings.Split(keyPath, ".")
	var k *yaml.Node
	for _, part := range parts {
		if node == nil || node.Kind != yaml.MappingNode {
			return nil, nil, false
		}
		k, node = child(node, part)
		if node == nil {
			return nil, nil, false
		}
	}
	return k, node, true
}

// parentRef names where a leaf key should be read or written: either an
// existing mapping node, or a path of mapping keys that do not exist yet and
// must be created first (none of ours create intermediate maps today — the
// registry this serves is one level deep under a top-level section — so an
// absent parent that is more than one hop missing is refused rather than
// guessed at).
type parentRef struct {
	key  *yaml.Node // the parent's own key node (nil at the document root)
	node *yaml.Node // the parent mapping node
}

// walkMappingParents resolves the mapping that should hold the leaf key,
// requiring every named path element to already exist as a mapping.
// Configedit's registry entries are always "section.key" — one level — so
// this never needs to synthesize an intermediate map; a caller asking for a
// deeper, not-yet-existing path gets ErrShapeUnexpected rather than a guess.
func walkMappingParents(doc []byte, path []string) (parentRef, error) {
	root, err := mapping(doc)
	if err != nil {
		return parentRef{}, err
	}
	var key *yaml.Node
	node := root
	for _, part := range path {
		if node.Kind != yaml.MappingNode {
			return parentRef{}, fmt.Errorf("%w: %s is not a mapping", ErrShapeUnexpected, part)
		}
		k, v := child(node, part)
		if v == nil {
			return parentRef{}, fmt.Errorf("%w: %s does not exist", ErrShapeUnexpected, part)
		}
		key, node = k, v
	}
	if node.Kind != yaml.MappingNode {
		return parentRef{}, fmt.Errorf("%w: parent is not a mapping", ErrShapeUnexpected)
	}
	return parentRef{key: key, node: node}, nil
}

// insertionLine is the line to insert a new child after: the parent key's own
// line, or line 0 (the start of the document) when the parent is the
// document root, which has no key of its own.
func insertionLine(parentKey, parentNode *yaml.Node) int {
	if parentKey != nil {
		return parentKey.Line
	}
	if len(parentNode.Content) > 0 {
		// Root mapping with no named key: insert after its last existing
		// top-level entry's value, so a new section lands at the end of the
		// document rather than before everything else.
		last := parentNode.Content[len(parentNode.Content)-1]
		return lastLineOf(last)
	}
	return 0
}

// lastLineOf is the deepest line a node's own text occupies, so inserting
// "after" it lands after any nested block it owns, not in the middle of it.
func lastLineOf(n *yaml.Node) int {
	line := n.Line
	for _, c := range n.Content {
		if l := lastLineOf(c); l > line {
			line = l
		}
	}
	return line
}

// parentIndent is the indentation a new child of parentNode should use: the
// parent key's own indent plus two spaces, or "" at the document root.
func parentIndent(lines []string, parentKey, parentNode *yaml.Node) string {
	if parentKey == nil {
		return ""
	}
	return leadingSpace(lineAt(lines, parentKey.Line)) + "  "
}

// ---- value formatting --------------------------------------------------------

// scalarText renders v the way a plain (unquoted) YAML scalar is written.
// Every value this package writes today is one `SetScalar` caller already
// validated against a known shape (an int, a bool, or a plain string), so no
// quoting rules beyond "quote a string that would otherwise parse as
// something else" are needed.
func scalarText(v any) string {
	switch t := v.(type) {
	case string:
		if needsQuoting(t) {
			return fmt.Sprintf("%q", t)
		}
		return t
	case bool, int, int64, float64:
		return fmt.Sprint(t)
	default:
		return fmt.Sprint(t)
	}
}

func needsQuoting(s string) bool {
	if s == "" {
		return true
	}
	var probe any
	if err := yaml.Unmarshal([]byte(s), &probe); err != nil {
		return true
	}
	if _, isString := probe.(string); !isString {
		return true
	}
	return fmt.Sprint(probe) != s
}

// ---- additive-write comparison helpers ---------------------------------------

func deleteKeyPath(doc map[string]any, keyPath string) {
	parts := strings.Split(keyPath, ".")
	node := doc
	for i, part := range parts {
		if i == len(parts)-1 {
			delete(node, part)
			return
		}
		next, ok := node[part].(map[string]any)
		if !ok {
			return
		}
		node = next
	}
}

// removeListItems removes exactly the named items from the list at keyPath in
// doc, leaving every other entry (an operator's own) untouched.
func removeListItems(doc map[string]any, keyPath string, items []string) {
	parts := strings.Split(keyPath, ".")
	node := doc
	for i, part := range parts {
		if i == len(parts)-1 {
			raw, ok := node[part].([]any)
			if !ok {
				return
			}
			remove := map[string]bool{}
			for _, it := range items {
				remove[it] = true
			}
			kept := make([]any, 0, len(raw))
			for _, it := range raw {
				s, _ := it.(string)
				if remove[s] {
					delete(remove, s) // only the first matching occurrence
					continue
				}
				kept = append(kept, it)
			}
			node[part] = kept
			return
		}
		next, ok := node[part].(map[string]any)
		if !ok {
			return
		}
		node = next
	}
}

func dedupe(items []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(items))
	for _, it := range items {
		if !seen[it] {
			seen[it] = true
			out = append(out, it)
		}
	}
	return out
}

// ---- document and line helpers, following hermeslive/config.go closely -----

func mapping(data []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("configedit: document is not valid YAML: %w", err)
	}
	if doc.Kind == 0 && len(strings.TrimSpace(string(data))) == 0 {
		return &yaml.Node{Kind: yaml.MappingNode}, nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%w: document is not a mapping", ErrShapeUnexpected)
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

// replaceScalar swaps a scalar's value on its own line, keeping the key text
// and any trailing comment.
func replaceScalar(lines []string, key, value *yaml.Node, replacement string) ([]byte, error) {
	if key.Line != value.Line || value.Column < 1 {
		return nil, fmt.Errorf("%s is not a one-line setting", key.Value)
	}
	line := lineAt(lines, value.Line)
	start := value.Column - 1
	if start+len(value.Value) > len(line) || line[start:start+len(value.Value)] != value.Value {
		return nil, fmt.Errorf("%s is not written the way it parses", key.Value)
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
