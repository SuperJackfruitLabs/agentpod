package skills

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Registering a managed directory in a profile's skills.external_dirs is a
// harness configuration mutation, which no other adapter performs. It is kept
// separate from publishing files so that placing a skill can never silently
// change what a user's Hermes profile loads, and so the change can be reviewed
// and reversed on its own.
//
// The document is parsed to decide what to do and edited as lines to do it.
// Re-encoding through the YAML marshaller preserves comments and meaning but
// reflows the file — on a real profile it re-indented every nested sequence —
// and rewriting an operator's configuration to add one entry is not this
// node's to do. Every line outside the edit stays byte for byte as it was.
type ExternalDirsPlan struct {
	ConfigPath string `json:"configPath"`
	Entry      string `json:"entry"`
	Action     string `json:"action"`
	Present    bool   `json:"present"`
	NoOp       bool   `json:"noOp"`
	Before     string `json:"before"`
	After      string `json:"after"`
}

// PlanExternalDirs reports the exact edit that registering or unregistering the
// managed directory would make, and returns the proposed document so a caller
// can diff it before anything is written.
//
// It never creates a configuration file. A profile with no config.yaml is one
// whose defaults this node has not been asked to change, and writing one would
// be a larger claim than registering a directory.
func PlanExternalDirs(configPath, entry, action string) (ExternalDirsPlan, []byte, error) {
	if !filepath.IsAbs(configPath) {
		return ExternalDirsPlan{}, nil, fmt.Errorf("skills: external dirs config path must be absolute")
	}
	if entry == "" || filepath.IsAbs(entry) || strings.ContainsAny(entry, "\n\"'#:") {
		return ExternalDirsPlan{}, nil, fmt.Errorf("skills: external dirs entry must be a plain relative path")
	}
	if action != "register" && action != "unregister" {
		return ExternalDirsPlan{}, nil, fmt.Errorf("skills: unknown external dirs action")
	}
	current, err := os.ReadFile(configPath)
	if err != nil {
		return ExternalDirsPlan{}, nil, err
	}
	root, err := documentMapping(current)
	if err != nil {
		return ExternalDirsPlan{}, nil, err
	}
	plan := ExternalDirsPlan{ConfigPath: configPath, Entry: entry, Action: action, Before: hashBytes(current)}
	unchanged := func() (ExternalDirsPlan, []byte, error) {
		plan.NoOp, plan.After = true, plan.Before
		return plan, current, nil
	}

	skillsKey, skillsValue := childNode(root, "skills")
	if skillsValue != nil && skillsValue.Kind != yaml.MappingNode && !isNull(skillsValue) {
		return ExternalDirsPlan{}, nil, fmt.Errorf("%w: skills is not a mapping in the profile configuration", ErrInstallConflict)
	}
	var listKey, listValue *yaml.Node
	if skillsValue != nil && skillsValue.Kind == yaml.MappingNode {
		listKey, listValue = childNode(skillsValue, "external_dirs")
		if listValue != nil && listValue.Kind != yaml.SequenceNode && !isNull(listValue) {
			return ExternalDirsPlan{}, nil, fmt.Errorf("%w: external_dirs is not a sequence in the profile configuration", ErrInstallConflict)
		}
	}
	if listValue != nil && listValue.Kind == yaml.SequenceNode {
		for _, item := range listValue.Content {
			if item.Kind != yaml.ScalarNode {
				return ExternalDirsPlan{}, nil, fmt.Errorf("%w: external_dirs holds a non-scalar entry", ErrInstallConflict)
			}
			if item.Value == entry {
				plan.Present = true
			}
		}
	}
	if (action == "register") == plan.Present {
		return unchanged()
	}
	if action == "unregister" {
		if listValue == nil {
			return unchanged()
		}
		edited, err := removeEntryLine(current, listValue, entry)
		if err != nil {
			return ExternalDirsPlan{}, nil, err
		}
		return finish(plan, current, edited, entry, action)
	}
	edited, err := insertEntry(current, skillsKey, skillsValue, listKey, listValue, entry)
	if err != nil {
		return ExternalDirsPlan{}, nil, err
	}
	return finish(plan, current, edited, entry, action)
}

func finish(plan ExternalDirsPlan, current, edited []byte, entry, action string) (ExternalDirsPlan, []byte, error) {
	// A line edit that produced invalid YAML, or moved anything but this key,
	// must never reach an apply.
	if err := verifyOnlyEntryChanged(current, edited, entry, action); err != nil {
		return ExternalDirsPlan{}, nil, err
	}
	plan.After = hashBytes(edited)
	return plan, edited, nil
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
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrInstallConflict)
		}
		line := lines[listValue.Line-1]
		close := strings.LastIndex(line, "]")
		if close < 0 {
			return nil, fmt.Errorf("%w: external_dirs is an inline list this node cannot extend", ErrInstallConflict)
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
			return nil, fmt.Errorf("%w: external_dirs entry has no position", ErrInstallConflict)
		}
		item := lines[last.Line-1]
		dash := strings.Index(item, "- ")
		if dash < 0 || strings.TrimSpace(item[:dash]) != "" {
			// An item this editor did not write, or an unexpected shape.
			return nil, fmt.Errorf("%w: external_dirs is not a block sequence this node can extend", ErrInstallConflict)
		}
		return insertAt(lines, last.Line, item[:dash]+"- "+entry), nil
	case listValue != nil:
		// An explicit null: the key stays exactly as written and the entry
		// becomes the first block item beneath it.
		if listKey.Line < 1 || listKey.Line > len(lines) {
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrInstallConflict)
		}
		indent := leadingSpace(lines[listKey.Line-1])
		return insertAt(lines, listKey.Line, indent+"  - "+entry), nil
	case skillsValue != nil && skillsValue.Kind == yaml.MappingNode:
		if skillsKey.Line < 1 || skillsKey.Line > len(lines) {
			return nil, fmt.Errorf("%w: skills has no position", ErrInstallConflict)
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
			return nil, fmt.Errorf("%w: external_dirs has no position", ErrInstallConflict)
		}
		line := lines[list.Line-1]
		open, close := strings.Index(line, "["), strings.LastIndex(line, "]")
		if open < 0 || close < open {
			return nil, fmt.Errorf("%w: external_dirs is an inline list this node cannot edit", ErrInstallConflict)
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
			return nil, fmt.Errorf("%w: external_dirs entry has no position", ErrInstallConflict)
		}
		text := lines[item.Line-1]
		if !strings.Contains(text, "- ") || !strings.Contains(text, entry) {
			return nil, fmt.Errorf("%w: external_dirs entry is not on a line of its own", ErrInstallConflict)
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
	return nil, fmt.Errorf("%w: external_dirs entry was not found to remove", ErrInstallConflict)
}

// verifyOnlyEntryChanged reparses the edit and compares it with the original,
// so a textual insertion cannot quietly alter an unrelated setting.
func verifyOnlyEntryChanged(current, edited []byte, entry, action string) error {
	var before, after map[string]any
	if err := yaml.Unmarshal(current, &before); err != nil {
		return err
	}
	if err := yaml.Unmarshal(edited, &after); err != nil {
		return fmt.Errorf("skills: the proposed profile configuration is not valid YAML: %w", err)
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
		return fmt.Errorf("%w: the edit did not produce the reviewed external_dirs", ErrInstallConflict)
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
		return fmt.Errorf("%w: the edit changed a setting outside external_dirs", ErrInstallConflict)
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
		return nil, fmt.Errorf("skills: profile configuration is not valid YAML: %w", err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%w: profile configuration is not a mapping", ErrInstallConflict)
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

// ApplyExternalDirs writes the reviewed document, refusing if the file changed
// since it was planned. A profile configuration is edited by its owner and by
// Hermes itself, so applying a stale plan could drop an unrelated setting the
// operator added in between.
func ApplyExternalDirs(plan ExternalDirsPlan, proposed []byte) error {
	if plan.ConfigPath == "" || plan.Before == "" || plan.After == "" {
		return fmt.Errorf("skills: incomplete external dirs plan")
	}
	if hashBytes(proposed) != plan.After {
		return fmt.Errorf("%w: reviewed external dirs document does not match its plan", ErrInstallConflict)
	}
	current, err := os.ReadFile(plan.ConfigPath)
	if err != nil {
		return err
	}
	if hashBytes(current) != plan.Before {
		return fmt.Errorf("%w: profile configuration changed since it was reviewed", ErrInstallConflict)
	}
	if plan.NoOp {
		return nil
	}
	info, err := os.Stat(plan.ConfigPath)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(plan.ConfigPath), ".agentpod-hermes-config-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(proposed); err != nil {
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
	return os.Rename(name, plan.ConfigPath)
}
