// Package hermesskills registers the managed skills directory in a Hermes
// profile's skills.external_dirs. It mirrors internal/hermeslive's shape —
// a pure decide step and a separate, staleness-checked apply — so the
// codebase has one idiom for editing a Hermes profile configuration, not two.
//
// Extracted from cmd/agentpod-node/hermes_skills.go (which called it, by way
// of the former internal/skills.PlanExternalDirs/ApplyExternalDirs, as its
// whole implementation) so that internal/descriptor can declare this setting
// through the registry and delegate to the same writer the apn verb uses,
// rather than reimplementing the edit.
package hermesskills

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ErrConflict is a profile configuration this package will not edit: an
// unexpected shape, or one that changed since it was reviewed.
var ErrConflict = errors.New("hermes-skills: conflict")

// Registering a managed directory in a profile's skills.external_dirs is a
// harness configuration mutation. It is kept separate from publishing files
// so that placing a skill can never silently change what a user's Hermes
// profile loads, and so the change can be reviewed and reversed on its own.
//
// The document is parsed to decide what to do and edited as lines to do it.
// Re-encoding through the YAML marshaller preserves comments and meaning but
// reflows the file — on a real profile it re-indented every nested sequence
// — and rewriting an operator's configuration to add one entry is not this
// node's to do. Every line outside the edit stays byte for byte as it was.

// Change records what Register or Unregister found and did. Present and
// NoOp are what a caller reports to the operator; ListCreated is extra
// detail Register alone produces. The hashes are what Apply uses to refuse
// a write if the document changed since the edit was computed — unlike
// hermeslive's enable/disable pair, Register and Unregister are each
// independently idempotent, so a Change is never replayed into the other
// direction, only ever handed back to Apply for the call that produced it.
type Change struct {
	// Present is whether dir was already named in skills.external_dirs
	// before this call, independent of which function was called. This is
	// the fact "status" reports, and the fact that makes an action a no-op.
	Present bool
	// NoOp is whether no edit is needed: Register when Present, Unregister
	// when not.
	NoOp bool
	// ListCreated is whether skills.external_dirs (and possibly skills:
	// itself) did not exist and had to be created to hold the entry.
	// Always false for Unregister.
	ListCreated bool

	before string
	after  string
}

// Register reports the edit that would add dir to a profile's
// skills.external_dirs, additively: an entry the operator already has is
// kept, and a dir already present is a no-op. It never writes anything —
// see Apply — and it never creates a configuration file: a profile with no
// config.yaml is one whose defaults this node has not been asked to change,
// and writing one would be a larger claim than registering a directory.
func Register(configPath, dir string) (edited []byte, change Change, err error) {
	current, loc, err := readForEdit(configPath, dir)
	if err != nil {
		return nil, Change{}, err
	}
	before := hashBytes(current)
	if loc.present {
		return current, Change{Present: true, NoOp: true, before: before, after: before}, nil
	}
	edited, err = insertEntry(current, loc.skillsKey, loc.skillsValue, loc.listKey, loc.listValue, dir)
	if err != nil {
		return nil, Change{}, err
	}
	if err := verifyOnlyEntryChanged(current, edited, dir, "register"); err != nil {
		return nil, Change{}, err
	}
	return edited, Change{ListCreated: loc.listValue == nil, before: before, after: hashBytes(edited)}, nil
}

// Unregister reports the edit that would remove dir from skills.external_dirs.
// A dir not present (or no list to remove it from) is a no-op: edited equals
// the document exactly as read.
func Unregister(configPath, dir string) (edited []byte, change Change, err error) {
	current, loc, err := readForEdit(configPath, dir)
	if err != nil {
		return nil, Change{}, err
	}
	before := hashBytes(current)
	if !loc.present || loc.listValue == nil {
		return current, Change{Present: loc.present, NoOp: true, before: before, after: before}, nil
	}
	edited, err = removeEntryLine(current, loc.listValue, dir)
	if err != nil {
		return nil, Change{}, err
	}
	if err := verifyOnlyEntryChanged(current, edited, dir, "unregister"); err != nil {
		return nil, Change{}, err
	}
	return edited, Change{Present: true, before: before, after: hashBytes(edited)}, nil
}

// Apply writes a reviewed edit, refusing if the document at configPath no
// longer matches the one Register or Unregister read — the profile is
// edited by its owner and by Hermes itself, so applying a stale review
// could drop an unrelated setting the operator added in between. This is
// the only writer in this package: Register and Unregister never touch
// disk, and there is no second way to write a file.
func Apply(configPath string, change Change, edited []byte) error {
	if change.before == "" || change.after == "" {
		return fmt.Errorf("hermes-skills: incomplete change")
	}
	if hashBytes(edited) != change.after {
		return fmt.Errorf("%w: reviewed external_dirs document does not match its plan", ErrConflict)
	}
	current, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	if hashBytes(current) != change.before {
		return fmt.Errorf("%w: profile configuration changed since it was reviewed", ErrConflict)
	}
	if change.NoOp {
		return nil
	}
	info, err := os.Stat(configPath)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(configPath), ".agentpod-hermes-config-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(edited); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err = temporary.Close(); err != nil {
		return err
	}
	if err = os.Chmod(name, info.Mode().Perm()); err != nil {
		return err
	}
	return os.Rename(name, configPath)
}

// location is what reading the document for an edit finds: where
// skills: and skills.external_dirs are, and whether dir is already there.
type location struct {
	skillsKey, skillsValue *yaml.Node
	listKey, listValue     *yaml.Node
	present                bool
}

func readForEdit(configPath, dir string) ([]byte, location, error) {
	if !filepath.IsAbs(configPath) {
		return nil, location{}, fmt.Errorf("hermes-skills: external dirs config path must be absolute")
	}
	if dir == "" || filepath.IsAbs(dir) || strings.ContainsAny(dir, "\n\"'#:") {
		return nil, location{}, fmt.Errorf("hermes-skills: external dirs entry must be a plain relative path")
	}
	current, err := os.ReadFile(configPath)
	if err != nil {
		return nil, location{}, err
	}
	root, err := documentMapping(current)
	if err != nil {
		return nil, location{}, err
	}
	var loc location
	loc.skillsKey, loc.skillsValue = childNode(root, "skills")
	if loc.skillsValue != nil && loc.skillsValue.Kind != yaml.MappingNode && !isNull(loc.skillsValue) {
		return nil, location{}, fmt.Errorf("%w: skills is not a mapping in the profile configuration", ErrConflict)
	}
	if loc.skillsValue != nil && loc.skillsValue.Kind == yaml.MappingNode {
		loc.listKey, loc.listValue = childNode(loc.skillsValue, "external_dirs")
		if loc.listValue != nil && loc.listValue.Kind != yaml.SequenceNode && !isNull(loc.listValue) {
			return nil, location{}, fmt.Errorf("%w: external_dirs is not a sequence in the profile configuration", ErrConflict)
		}
	}
	if loc.listValue != nil && loc.listValue.Kind == yaml.SequenceNode {
		for _, item := range loc.listValue.Content {
			if item.Kind != yaml.ScalarNode {
				return nil, location{}, fmt.Errorf("%w: external_dirs holds a non-scalar entry", ErrConflict)
			}
			if item.Value == dir {
				loc.present = true
			}
		}
	}
	return current, loc, nil
}

// insertEntry adds the entry, creating skills or external_dirs textually when
// they are absent so that the surrounding document is never re-serialised.
func insertEntry(current []byte, skillsKey, skillsValue, listKey, listValue *yaml.Node, entry string) ([]byte, error) {
	lines := splitLines(current)
	switch {
	case listValue != nil && listValue.Style&yaml.FlowStyle != 0:
		// The operator wrote an inline list. Keep their style and extend it in
		// place, so a registration changes one line and converts nothing.
		if listValue.Line < 1 || listValue.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrConflict)
		}
		line := lines[listValue.Line-1]
		close := strings.LastIndex(line, "]")
		if close < 0 {
			return nil, fmt.Errorf("%w: external_dirs is an inline list this node cannot extend", ErrConflict)
		}
		inner := strings.TrimSpace(line[strings.Index(line, "[")+1 : close])
		addition := entry
		if inner != "" {
			addition = ", " + entry
		}
		lines[listValue.Line-1] = line[:close] + addition + line[close:]
		return joinLines(lines), nil
	case listValue != nil && listValue.Kind == yaml.SequenceNode && len(listValue.Content) > 0:
		last := listValue.Content[len(listValue.Content)-1]
		if last.Line < 1 || last.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs entry has no position", ErrConflict)
		}
		item := lines[last.Line-1]
		dash := strings.Index(item, "- ")
		if dash < 0 || strings.TrimSpace(item[:dash]) != "" {
			// An item this editor did not write, or an unexpected shape.
			return nil, fmt.Errorf("%w: external_dirs is not a block sequence this node can extend", ErrConflict)
		}
		return insertAt(lines, last.Line, item[:dash]+"- "+entry), nil
	case listValue != nil:
		// An explicit null: the key stays exactly as written and the entry
		// becomes the first block item beneath it.
		if listKey.Line < 1 || listKey.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrConflict)
		}
		indent := leadingSpace(lines[listKey.Line-1])
		return insertAt(lines, listKey.Line, indent+"  - "+entry), nil
	case skillsValue != nil && skillsValue.Kind == yaml.MappingNode:
		if skillsKey.Line < 1 || skillsKey.Line > len(lines) {
			return nil, fmt.Errorf("%w: skills has no position", ErrConflict)
		}
		indent := leadingSpace(lines[skillsKey.Line-1])
		return insertAt(lines, skillsKey.Line, indent+"  external_dirs:", indent+"    - "+entry), nil
	default:
		// No skills mapping at all: append one rather than reshape the file.
		return appendBlock(current, "skills:\n  external_dirs:\n    - "+entry+"\n"), nil
	}
}

func removeEntryLine(current []byte, list *yaml.Node, entry string) ([]byte, error) {
	lines := splitLines(current)
	// An inline list is edited in place, keeping the operator's style, so a
	// register/unregister pair returns the file to what it was.
	if list.Style&yaml.FlowStyle != 0 {
		if list.Line < 1 || list.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrConflict)
		}
		line := lines[list.Line-1]
		open, close := strings.Index(line, "["), strings.LastIndex(line, "]")
		if open < 0 || close < open {
			return nil, fmt.Errorf("%w: external_dirs is an inline list this node cannot edit", ErrConflict)
		}
		kept := make([]string, 0, len(list.Content))
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
		if item.Line < 1 || item.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs entry has no position", ErrConflict)
		}
		text := lines[item.Line-1]
		if !strings.Contains(text, "- ") || !strings.Contains(text, entry) {
			return nil, fmt.Errorf("%w: external_dirs entry is not on a line of its own", ErrConflict)
		}
		// Removing the only item would leave a dangling key, so the key
		// becomes an explicit empty list rather than a null.
		if len(list.Content) == 1 {
			lines[item.Line-1] = strings.TrimRight(lines[item.Line-1], "\n")
			dash := strings.Index(text, "- ")
			lines[item.Line-1] = text[:dash] + "[]"
			// The key line keeps its own text; only this line changes.
			return joinLines(removeAt(lines, item.Line)), nil
		}
		return joinLines(removeAt(lines, item.Line)), nil
	}
	return nil, fmt.Errorf("%w: external_dirs entry was not found to remove", ErrConflict)
}

// verifyOnlyEntryChanged reparses the edit and compares it with the original,
// so a textual insertion cannot quietly alter an unrelated setting.
func verifyOnlyEntryChanged(current, edited []byte, entry, action string) error {
	var before, after map[string]any
	if err := yaml.Unmarshal(current, &before); err != nil {
		return err
	}
	if err := yaml.Unmarshal(edited, &after); err != nil {
		return fmt.Errorf("hermes-skills: the proposed profile configuration is not valid YAML: %w", err)
	}
	beforeList := externalDirsOf(before)
	afterList := externalDirsOf(after)
	want := append([]string(nil), beforeList...)
	if action == "register" {
		want = append(want, entry)
	} else {
		want = want[:0]
		for _, v := range beforeList {
			if v != entry {
				want = append(want, v)
			}
		}
	}
	if strings.Join(afterList, "\x00") != strings.Join(want, "\x00") {
		return fmt.Errorf("%w: the edit did not produce the reviewed external_dirs", ErrConflict)
	}
	stripExternalDirs(before)
	stripExternalDirs(after)
	beforeText, err := yaml.Marshal(before)
	if err != nil {
		return err
	}
	afterText, err := yaml.Marshal(after)
	if err != nil {
		return err
	}
	if string(beforeText) != string(afterText) {
		return fmt.Errorf("%w: the edit changed a setting outside external_dirs", ErrConflict)
	}
	return nil
}

func externalDirsOf(doc map[string]any) []string {
	skills, _ := doc["skills"].(map[string]any)
	raw, _ := skills["external_dirs"].([]any)
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		out = append(out, fmt.Sprint(v))
	}
	return out
}

func stripExternalDirs(doc map[string]any) {
	skills, ok := doc["skills"].(map[string]any)
	if !ok {
		return
	}
	delete(skills, "external_dirs")
	if len(skills) == 0 {
		delete(doc, "skills")
	}
}

func documentMapping(current []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(current, &doc); err != nil {
		return nil, fmt.Errorf("hermes-skills: profile configuration is not valid YAML: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%w: profile configuration is not a mapping", ErrConflict)
	}
	return doc.Content[0], nil
}

func childNode(parent *yaml.Node, key string) (*yaml.Node, *yaml.Node) {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			return parent.Content[i], parent.Content[i+1]
		}
	}
	return nil, nil
}

func isNull(n *yaml.Node) bool { return n.Kind == yaml.ScalarNode && n.Tag == "!!null" }

func leadingSpace(line string) string { return line[:len(line)-len(strings.TrimLeft(line, " \t"))] }

func splitLines(data []byte) []string { return strings.Split(string(data), "\n") }

func joinLines(lines []string) []byte { return []byte(strings.Join(lines, "\n")) }

func insertAt(lines []string, after int, added ...string) []byte {
	out := make([]string, 0, len(lines)+len(added))
	out = append(out, lines[:after]...)
	out = append(out, added...)
	out = append(out, lines[after:]...)
	return joinLines(out)
}

func removeAt(lines []string, line int) []string {
	out := make([]string, 0, len(lines))
	out = append(out, lines[:line-1]...)
	return append(out, lines[line:]...)
}

func appendBlock(current []byte, block string) []byte {
	text := string(current)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return []byte(text + block)
}

func hashBytes(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }
