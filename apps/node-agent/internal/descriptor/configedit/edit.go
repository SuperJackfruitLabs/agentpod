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
// "create" also covers a whole top-level section that is not in the document
// yet: it is APPENDED at the end, holding nothing but this one key, so not a
// line the operator wrote moves. See walkMappingParents for why that is a
// create and not a refusal, and for the two cases that stay refusals.
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
	replacement, err := scalarText(v)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %s: %v", ErrShapeUnexpected, keyPath, err)
	}

	if parent.create != "" {
		return appendBlock(doc, parent.create+":\n  "+leaf+": "+replacement+"\n"), "create", nil
	}
	if parent.bareKey != nil {
		lines := splitLines(doc)
		indent := parentIndent(lines, parent.bareKey, nil)
		edited := insertAfter(lines, parent.bareKey.Line, indent+leaf+": "+replacement)
		return edited, "create", nil
	}

	lines := splitLines(doc)
	parentKey, parentNode := parent.key, parent.node
	key, node := child(parentNode, leaf)
	if node == nil {
		indent := parentIndent(lines, parentKey, parentNode)
		at, err := insertionLine(lines, parentKey, parentNode)
		if err != nil {
			return nil, "", err
		}
		edited := insertAfter(lines, at, indent+leaf+": "+replacement)
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
// key creates the list holding exactly the new items — and a missing top-level
// SECTION is appended at the end of the document holding only that list, for
// the reasons in walkMappingParents. A key present but not a sequence is
// ErrShapeUnexpected.
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

	if parent.create != "" {
		added := dedupe(items)
		if len(added) == 0 {
			// Nothing to add is nothing to write: an empty section is not
			// worth putting in an operator's file.
			return doc, "noop", nil, nil
		}
		block := parent.create + ":\n  " + leaf + ":\n"
		for _, item := range added {
			block += "    - " + item + "\n"
		}
		return appendBlock(doc, block), "append", added, nil
	}
	if parent.bareKey != nil {
		added := dedupe(items)
		if len(added) == 0 {
			return doc, "noop", nil, nil
		}
		lines := splitLines(doc)
		indent := parentIndent(lines, parent.bareKey, nil)
		block := []string{indent + leaf + ":"}
		for _, item := range added {
			block = append(block, indent+"  - "+item)
		}
		edited := insertAfter(lines, parent.bareKey.Line, block...)
		return edited, "append", added, nil
	}

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
		at, err := insertionLine(lines, parentKey, parentNode)
		if err != nil {
			return nil, "", nil, err
		}
		edited := insertAfter(lines, at, block...)
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
//
// A keyPath present in `additive` with no items is the strictest case, not a
// skipped one: nothing is taken out of `after`, so the list must be
// byte-for-byte the same on both sides. For an additive-only key the three
// notations for "no entries" — absent, an explicit null, and an empty list —
// are treated as one, because the editor moves between them when it creates
// the key or fills an empty one (see normalizeNoEntries).
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
	// Which parent sections `before` did not have at all, OR had only as a
	// BARE key holding nothing (`approvals:` with no value — the same "the
	// operator had nothing here" fact as an absent section, read BEFORE
	// anything is removed below. Those are the sections the editor may have
	// had to CREATE or EXTEND IN PLACE in order to write the key the caller
	// named, and once that key is set aside `after` carries an empty section
	// where `before` carries no section (or a bare one) — which a raw
	// DeepEqual calls a change outside the plan, rejecting the editor's own
	// edit and refusing the whole plan. That is the exact false whole-plan
	// refusal this check has produced three times now: once for a created
	// KEY, once for a created SECTION, and now for a BARE section filled in
	// place.
	createdSections := map[string]bool{}
	for _, kp := range keyPaths {
		parts := strings.Split(kp, ".")
		if len(parts) != 2 {
			continue
		}
		if v, present := b[parts[0]]; !present || v == nil {
			createdSections[parts[0]] = true
		}
	}
	// A bare section is present in `before` (with a nil value), unlike a
	// genuinely absent one. Drop it from `before` too so both sides end up
	// equally without the key once the plan's own addition is pruned from
	// `after` below — deleting an already-absent key is a no-op, so this is
	// safe for the absent case as well.
	for section := range createdSections {
		delete(b, section)
	}
	for _, kp := range keyPaths {
		if added, ok := additive[kp]; ok {
			// Remove only the items this apply says it added, from `after`.
			// The key stays in BOTH documents, so the operator's remaining
			// entries are compared and must still be unchanged.
			removeListItems(a, kp, added)
			// An additive write may have had to CREATE the key, or to fill a
			// key that was present holding nothing (`command_allowlist:` with
			// no items — the shape AppendToList has its own branch for). Once
			// the declared items are taken back out, `after` carries an empty
			// list where `before` carried an absent key or an explicit null,
			// and a raw DeepEqual calls that "something outside the keys this
			// plan touches changed" — rejecting the editor's own edit and
			// refusing the whole plan. For an additive-only key those three
			// notations say one thing, "the operator had no entries here", so
			// both sides are reduced to that one form before comparing. An
			// operator entry that survives keeps the key non-empty on both
			// sides, so a write that DROPPED one is still caught.
			normalizeNoEntries(b, kp)
			normalizeNoEntries(a, kp)
			continue
		}
		deleteKeyPath(b, kp)
		deleteKeyPath(a, kp)
	}
	// A section `before` never had (or had only bare), holding nothing once
	// this plan's own keys are set aside, says the same thing `before`'s
	// missing or bare section says: the operator had nothing here. Only
	// `after` is pruned here — `before` was already pruned above, and only
	// for a section `before` genuinely lacked or left bare, so this can never
	// hide a section the operator DID write being emptied — that side is left
	// exactly as it is and still compared. A created section that came out
	// holding anything else is likewise left alone, and refused.
	for section := range createdSections {
		if m, ok := a[section].(map[string]any); ok && len(m) == 0 {
			delete(a, section)
		}
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
// existing mapping node, or the one top-level section that is not in the
// document yet and has to be written before the leaf can go in it (none of
// ours create intermediate maps today — the registry this serves is one level
// deep under a top-level section — so an absent parent that is more than one
// hop missing is refused rather than guessed at).
type parentRef struct {
	key  *yaml.Node // the parent's own key node (nil at the document root)
	node *yaml.Node // the parent mapping node (nil when create is set)

	// create is the name of the single absent top-level section the caller
	// must write, holding nothing but the leaf key, before the leaf exists at
	// all; "" when the parent is already in the document. key and node are
	// nil in that case: there is no node to insert into yet.
	create string

	// bareKey is set instead of create when the parent section is not absent
	// but BARE — present in the document as a key holding nothing
	// (`approvals:` with no value) — so the leaf is inserted in place, right
	// after this key's own line, rather than appended as a new section at the
	// end of the document. This mirrors hermeslive.planEnableConfig's
	// handling of a bare `plugins:` key: extend it where the operator put it,
	// not wherever the end of the file happens to be.
	bareKey *yaml.Node
}

// walkMappingParents resolves the mapping that should hold the leaf key.
// Configedit's registry entries are always "section.key" — one level — so
// this never needs to synthesize an intermediate map.
//
// A single top-level section that is GENUINELY ABSENT is reported back as one
// to create, not refused. That is the adopt-time case the whole feature exists
// for: a freshly adopted station whose operator has customised nothing has no
// `approvals:` key at all, and refusing it made derivePlanConfig refuse the
// WHOLE plan — one absent section blocking every other setting declared
// alongside it. Creating an absent top-level section is already established,
// reviewed behaviour in this estate: `hermeslive.planEnableConfig` appends the
// entire `plugins:` block when `plugins` is nil, and appending touches nothing
// the operator wrote.
//
// A GENUINELY BARE single top-level section — present as a key holding
// nothing, `approvals:` with no value and nothing else on its own line — is
// likewise reported back to extend in place, for the same amplification
// reason: `derivePlanConfig` refuses the whole plan on one setting's shape,
// and an operator who has never touched a section leaves it exactly this way
// as often as they leave it absent. The precedent is
// `hermeslive.planEnableConfig`'s handling of a bare `plugins:` key, which
// this mirrors: only a line that reads EXACTLY "key:" is bare enough to
// extend, and the insertion point is the KEY's own line, never the value
// node's — a null value's reported line can fall on the NEXT sibling's line
// when nothing follows the colon, which is exactly the class of bug an
// earlier round of this feature hit inserting after a node's start line
// instead of after where its content actually ends.
//
// Two things stay refused, deliberately:
//
//   - A parent that EXISTS, is not a block mapping, and is not bare — a
//     scalar holding a value, a sequence, or an inline `{...}` mapping. Those
//     are shapes, not absences; this editor cannot extend them without
//     rewriting what the operator wrote, and it says so by name. Creating a
//     section is only for a parent that is genuinely absent or genuinely
//     bare — this does not widen into "make any shape work".
//   - A deeper absent path (`a.b.c` with `a` missing, or with `a` present and
//     `b` missing). Only ONE level of parent is ever created; the registry has
//     no such setting today, so a deeper guess would be exactly that.
func walkMappingParents(doc []byte, path []string) (parentRef, error) {
	root, err := mapping(doc)
	if err != nil {
		return parentRef{}, err
	}
	var key *yaml.Node
	node := root
	for i, part := range path {
		if node.Kind != yaml.MappingNode {
			return parentRef{}, fmt.Errorf("%w: %s is not a mapping", ErrShapeUnexpected, part)
		}
		k, v := child(node, part)
		if v == nil {
			if len(path) == 1 && i == 0 {
				return parentRef{create: part}, nil
			}
			return parentRef{}, fmt.Errorf("%w: %s does not exist", ErrShapeUnexpected, part)
		}
		key, node = k, v
	}
	if node.Kind != yaml.MappingNode {
		if len(path) == 1 && isEmptyValue(node) && isBareKeyLine(doc, key) {
			return parentRef{bareKey: key}, nil
		}
		// PRESENT, in a shape this editor will not extend: a scalar holding a
		// value, or a sequence. Named, so the refusal says which section it
		// is about rather than "parent".
		return parentRef{}, fmt.Errorf("%w: %s is not a mapping", ErrShapeUnexpected, parentName(key))
	}
	return parentRef{key: key, node: node}, nil
}

// isBareKeyLine reports whether key's own line, as written, is nothing but
// "key:" — the strict form hermeslive's planEnableConfig requires before
// extending a bare key in place. A key followed by a trailing comment is
// deliberately NOT bare enough: this editor would still write a correct
// edit, but the stricter check keeps this case identical to the reviewed
// precedent rather than inventing a second rule for it.
func isBareKeyLine(doc []byte, key *yaml.Node) bool {
	lines := splitLines(doc)
	return strings.TrimSpace(lineAt(lines, key.Line)) == key.Value+":"
}

// insertionLine is the line to insert a new child after: the last line the
// parent's existing children OCCUPY, so a created key lands at the END of
// its section — after the keys already there, inside its own section — and
// never in the middle of a value that takes more than one line.
//
// D5 says comments, key order and indentation are the operator's. Inserting
// immediately after the parent's own key line would satisfy the letter of
// that (nothing is rewritten) while still reordering their document — every
// created key would push itself in front of everything already written. The
// same rule applies at the document root, which has no key of its own, so
// this is one rule rather than two.
func insertionLine(lines []string, parentKey, parentNode *yaml.Node) (int, error) {
	if parentNode.Style&yaml.FlowStyle != 0 {
		// `approvals: {}` or `approvals: {mode: ask}` — a MappingNode whose
		// whole text is braces on one line. There is no line below it that is
		// inside the mapping, so a child written on the next line lands
		// outside the braces and the document stops parsing. Refused by name
		// rather than written: a sentence about the shape is a better answer
		// than a containment failure over a document this editor broke.
		return 0, fmt.Errorf("%w: %s is an inline mapping this editor cannot extend", ErrShapeUnexpected, parentName(parentKey))
	}
	if len(parentNode.Content) >= 2 {
		lastKey := parentNode.Content[len(parentNode.Content)-2]
		lastValue := parentNode.Content[len(parentNode.Content)-1]
		return endLineOf(lines, lastKey, lastValue), nil
	}
	if parentKey != nil {
		// Not reachable from any shape this editor accepts: a block mapping
		// written with no children parses as a null SCALAR, which
		// walkMappingParents refuses before this is called, and an empty FLOW
		// mapping is refused above. Kept so that a shape nobody has thought
		// of yet inserts inside the parent rather than falling through to the
		// document root.
		return parentKey.Line, nil
	}
	// An empty document: there is nothing for the new line to come after.
	return 0, nil
}

// endLineOf is the last line one child of a mapping — its key and its value
// together — occupies.
//
// `yaml.Node` carries a start Line and no end line, and a multi-line SCALAR
// has no `Content` to walk, so the end has to be read off the document
// itself. From the deepest line the node tree admits to, keep going while the
// following lines are blank or indented DEEPER than this child's own key: a
// literal or folded block (`|`, `>`), a multi-line plain scalar, a multi-line
// quoted scalar and a nested mapping or sequence are all exactly that shape,
// so one scan covers every one of them.
//
// The scan stops at the first line indented at or outside the child's key,
// which is both "the next sibling key" and "the end of this section" — so an
// insert after this line can never escape into a sibling section or the
// document root.
//
// `lastLineOf` still seeds the scan because a block sequence may be written
// at its KEY's indentation (`allow:` then `- ls` both at two spaces), which
// the indentation scan alone would stop at immediately; the node tree knows
// those items belong to the key and the document text does not.
func endLineOf(lines []string, key, value *yaml.Node) int {
	end := key.Line
	if deepest := lastLineOf(value); deepest > end {
		end = deepest
	}
	indent := len(leadingSpace(lineAt(lines, key.Line)))
	for n := end + 1; n <= len(lines); n++ {
		line := lines[n-1]
		if strings.TrimSpace(line) == "" {
			// A blank line inside a block scalar belongs to the scalar; a
			// blank line trailing the section belongs to the operator's
			// spacing. Keep scanning without moving `end` — only a deeper
			// line after it proves the value carried on.
			continue
		}
		if len(leadingSpace(line)) <= indent {
			break
		}
		end = n
	}
	return end
}

// lastLineOf is the deepest line the node tree reports for a node, which is
// the last line of a nested mapping or block sequence but only the FIRST line
// of a multi-line scalar — see endLineOf, which finishes the job.
func lastLineOf(n *yaml.Node) int {
	line := n.Line
	for _, c := range n.Content {
		if l := lastLineOf(c); l > line {
			line = l
		}
	}
	return line
}

// parentName names the mapping a child was going to be written into, for a
// refusal's own sentence.
func parentName(parentKey *yaml.Node) string {
	if parentKey == nil {
		return "the document root"
	}
	return parentKey.Value
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

// scalarText renders v the way a plain (unquoted) YAML scalar is written, and
// REFUSES anything that is not a scalar at all.
//
// The refusal lives here, at the point of writing, and not only in the caller
// that knows the setting's registered shape: this package is the thing that
// puts bytes in an operator's file, and a `default: fmt.Sprint(v)` arm will
// cheerfully render a map as `map[a:1]`, a slice as `[1 2]` and a nil as
// `<nil>`, each of which then parses back as a plain string nobody asked for.
// A declared value arrives as JSON, so a map, a list and a null are all
// reachable from one request; a caller that knows the policy can refuse them
// earlier with a better sentence, but no caller is TRUSTED to.
func scalarText(v any) (string, error) {
	switch t := v.(type) {
	case string:
		if needsQuoting(t) {
			return fmt.Sprintf("%q", t), nil
		}
		return t, nil
	case bool:
		return fmt.Sprint(t), nil
	case int, int8, int16, int32, int64:
		return fmt.Sprint(t), nil
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprint(t), nil
	case float32, float64:
		return fmt.Sprint(t), nil
	case nil:
		return "", errors.New("a null is not a scalar this editor writes — an explicit null and an absent key read the same way back, so there is no way to say which one was meant")
	default:
		return "", fmt.Errorf("a %T is not a scalar — only a string, a number or a boolean can be written as a one-line setting", v)
	}
}

// IsWritableScalar reports whether v is something SetScalar can write as a
// one-line YAML scalar. Exported so a caller that knows a setting's
// registered policy can refuse a wrongly-shaped declared value BY THE
// SETTING'S NAME, before a key path or a document shape is mentioned —
// without keeping a second, drifting list of the types this package accepts.
func IsWritableScalar(v any) bool {
	_, err := scalarText(v)
	return err == nil
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

// normalizeNoEntries deletes the key at keyPath when what is there holds no
// entries: an absent key, an explicit null, or an empty list. Called on BOTH
// documents, and only for an additive-only key, where those three notations
// are one fact — the operator had no entries here — and the editor is free to
// move between them (creating the key, or filling an empty one) without that
// counting as a change outside the plan.
//
// It never touches a key that holds entries, so it cannot hide an additive
// write that removed one.
func normalizeNoEntries(doc map[string]any, keyPath string) {
	parts := strings.Split(keyPath, ".")
	node := doc
	for i, part := range parts {
		if i == len(parts)-1 {
			v, present := node[part]
			if !present {
				return
			}
			if v == nil {
				delete(node, part)
				return
			}
			if list, ok := v.([]any); ok && len(list) == 0 {
				delete(node, part)
			}
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

// appendBlock puts block at the END of current, after everything already
// there, having first made sure the document ends in a newline so the block
// starts on a line of its own. Lifted from hermeslive/config.go, where it
// writes the whole `plugins:` section the same way, for the same reason: an
// append cannot disturb or reorder a single line the operator wrote.
func appendBlock(current []byte, block string) []byte {
	text := string(current)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return []byte(text + block)
}

func insertAfter(lines []string, after int, added ...string) []byte {
	out := make([]string, 0, len(lines)+len(added))
	out = append(out, lines[:after]...)
	out = append(out, added...)
	out = append(out, lines[after:]...)
	return joinLines(out)
}
