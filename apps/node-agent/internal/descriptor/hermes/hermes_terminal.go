package hermes

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/configedit"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
	"go.yaml.in/yaml/v3"
)

// SSHTerminal is the `terminal:` section a profile runs with while it is attached to a remote
// bench: Hermes's own SSH backend, pointed through the bench's door.
type SSHTerminal struct {
	Host    string
	Port    int
	User    string
	KeyPath string
	// Cwd is the bench's working directory. Always written: a new ACP session on an SSH backend
	// starts in the remote $HOME, not in the ACP cwd it was given.
	Cwd string
}

// BenchState is what the agentpod-live plugin reads to know the profile is attached
// (BenchStateFile). It holds no secret.
type BenchState struct {
	Version          int       `json:"version"`
	BenchID          string    `json:"bench_id"`
	WorkingDirectory string    `json:"working_directory"`
	ValidBefore      time.Time `json:"valid_before"`
}

// BenchStateFile is the attach state the plugin reads, in the profile's own directory.
const BenchStateFile = "agentpod-bench.json"

// TerminalInspection is what attach must know before it changes anything.
type TerminalInspection struct {
	// Backend is terminal.backend as written ("" when absent).
	Backend string
	// CredentialMounts names each reason Hermes would copy a credential file to the remote
	// backend: a non-empty terminal.credential_files, or a skill declaring
	// required_credential_files. Hermes's config list bypasses its own deny-list (`.env` was
	// copied in the spike), so any entry refuses the attach.
	CredentialMounts []string
}

// TerminalWriter edits a Hermes profile for a remote bench and undoes the edit exactly.
type TerminalWriter interface {
	Inspect(profileDir string) (TerminalInspection, error)
	// Prior is what SetSSH would return for the profile as it is now, without writing anything:
	// attach journals it before the edit, so a crash part way can still be undone exactly.
	Prior(profileDir string) (map[string]any, error)
	// SetSSH edits only config.yaml's terminal.{backend,ssh_host,ssh_port,ssh_user,ssh_key,cwd}
	// and returns what Restore needs to put those lines back byte for byte.
	SetSSH(profileDir string, t SSHTerminal) (prior map[string]any, err error)
	// Restore undoes SetSSH. When the six keys no longer hold what was written, someone else
	// changed the terminal section; it is left alone and changed is true.
	Restore(profileDir string, wrote SSHTerminal, prior map[string]any) (changed bool, err error)
	WriteState(profileDir string, s BenchState) error
	RemoveState(profileDir string) error
}

// HermesTerminal is the production TerminalWriter.
type HermesTerminal struct{}

var _ TerminalWriter = HermesTerminal{}

// terminalKeys are the keys SetSSH owns, in the order they are written.
var terminalKeys = []string{"backend", "ssh_host", "ssh_port", "ssh_user", "ssh_key", "cwd"}

const (
	priorSection    = "__section"     // "absent" | "bare" | "mapping"
	priorEOFNewline = "__eof_newline" // the file ended in a newline (or was empty)
)

func (t SSHTerminal) values() map[string]any {
	return map[string]any{
		"backend": "ssh", "ssh_host": t.Host, "ssh_port": t.Port, "ssh_user": t.User, "ssh_key": t.KeyPath, "cwd": t.Cwd,
	}
}

func readConfig(profileDir string) ([]byte, fs.FileMode, error) {
	path := filepath.Join(profileDir, "config.yaml")
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, fmt.Errorf("hermes: %s has no config.yaml; refusing to edit an unrecognised profile", profileDir)
		}
		return nil, 0, fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, 0, fmt.Errorf("hermes: reading config.yaml: %w", err)
	}
	return data, info.Mode().Perm(), nil
}

// Inspect reads terminal.backend and every credential mount the profile would make.
func (HermesTerminal) Inspect(profileDir string) (TerminalInspection, error) {
	config, _, err := readConfig(profileDir)
	if err != nil {
		return TerminalInspection{}, err
	}
	var out TerminalInspection
	if v, ok, err := configedit.Read(config, "terminal.backend"); err != nil {
		return out, fmt.Errorf("hermes: config.yaml: %w", err)
	} else if ok && v != nil {
		out.Backend = strings.TrimSpace(fmt.Sprint(v))
	}
	if v, ok, _ := configedit.Read(config, "terminal.credential_files"); ok && !emptyValue(v) {
		out.CredentialMounts = append(out.CredentialMounts, "terminal.credential_files is set")
	}
	roots := []string{filepath.Join(profileDir, "skills")}
	if v, ok, _ := configedit.Read(config, "skills.external_dirs"); ok {
		if list, isList := v.([]any); isList {
			for _, item := range list {
				if s, isStr := item.(string); isStr && s != "" {
					roots = append(roots, expandHome(s))
				}
			}
		}
	}
	for _, root := range roots {
		out.CredentialMounts = append(out.CredentialMounts, skillsDeclaringCredentialFiles(root)...)
	}
	return out, nil
}

func emptyValue(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case string:
		return strings.TrimSpace(t) == ""
	case []any:
		return len(t) == 0
	case map[string]any:
		return len(t) == 0
	}
	return false
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// skillsDeclaringCredentialFiles names each SKILL.md under root whose frontmatter declares
// required_credential_files (Hermes `tools/skills_tool.py` registers them on load). Every skill is
// counted, enabled or not: over-refusing costs an operator one edit, under-refusing copies a
// credential off the machine. A frontmatter that does not parse but mentions the key counts too.
func skillsDeclaringCredentialFiles(root string) []string {
	var found []string
	scanSkills(root, "", 0, &found)
	sort.Strings(found)
	return found
}

// skillScanDepth bounds the walk: Hermes keeps a skill at most a category and a name deep, and a
// symlink loop must not hang an attach.
const skillScanDepth = 6

// scanSkills walks dir (rel below the skills root), following symlinks the way Hermes's own
// discovery does. Hidden directories are Hermes's state, not skills.
func scanSkills(dir, rel string, depth int, found *[]string) {
	if depth > skillScanDepth {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return // no skills directory, or one Hermes cannot read either
	}
	for _, e := range entries {
		name := e.Name()
		path := filepath.Join(dir, name)
		info, statErr := os.Stat(path)
		switch {
		case statErr != nil:
		case info.IsDir() && !strings.HasPrefix(name, "."):
			scanSkills(path, filepath.Join(rel, name), depth+1, found)
		case name == "SKILL.md" && declaresCredentialFiles(path):
			*found = append(*found, "skill "+rel+" declares required_credential_files")
		}
	}
}

func declaresCredentialFiles(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(data, []byte("required_credential_files")) {
		return false
	}
	front, ok := frontmatter(data)
	var meta map[string]any
	return !ok || yaml.Unmarshal(front, &meta) != nil || !emptyValue(meta["required_credential_files"])
}

func frontmatter(data []byte) ([]byte, bool) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	if !strings.HasPrefix(text, "---\n") {
		return nil, false
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return nil, false
	}
	return []byte(text[4 : 4+end]), true
}

// Prior reads the restore record SetSSH would produce, and writes nothing.
func (HermesTerminal) Prior(profileDir string) (map[string]any, error) {
	config, _, err := readConfig(profileDir)
	if err != nil {
		return nil, err
	}
	prior, _, err := terminalPrior(config)
	return prior, err
}

// SetSSH writes the six terminal keys, one line each, keeping every other line as it was.
func (HermesTerminal) SetSSH(profileDir string, t SSHTerminal) (map[string]any, error) {
	if t.Host == "" || t.User == "" || t.KeyPath == "" || t.Cwd == "" || t.Port <= 0 || t.Port > 65535 {
		return nil, errors.New("hermes: incomplete ssh terminal")
	}
	for _, s := range []string{t.Host, t.User, t.KeyPath, t.Cwd} {
		if strings.ContainsAny(s, "\r\n") {
			return nil, errors.New("hermes: ssh terminal value contains a newline")
		}
	}
	config, perm, err := readConfig(profileDir)
	if err != nil {
		return nil, err
	}
	prior, at, err := terminalPrior(config)
	if err != nil {
		return nil, err
	}
	values := t.values()
	// A key already there is rewritten as a whole line (the old line, quotes and comment and all,
	// is in prior); a missing one is created where configedit puts it.
	lines := strings.Split(string(config), "\n")
	for _, k := range terminalKeys {
		raw, ok := prior[k].(string)
		if !ok {
			continue
		}
		text, err := scalarLine(raw, k, values[k])
		if err != nil {
			return nil, err
		}
		lines[at[k]-1] = text
	}
	out := []byte(strings.Join(lines, "\n"))
	for _, k := range terminalKeys {
		if _, ok := prior[k].(string); ok {
			continue
		}
		if out, _, err = configedit.SetScalar(out, "terminal."+k, values[k]); err != nil {
			return nil, fmt.Errorf("hermes: config.yaml terminal.%s: %w", k, err)
		}
	}
	if err := configedit.SameOutsideKeys(config, out, terminalKeyPaths(), nil); err != nil {
		return nil, fmt.Errorf("hermes: refusing to write config.yaml: %w", err)
	}
	if !bytes.Equal(out, config) {
		if err := hostfs.AtomicWriteFile(filepath.Join(profileDir, "config.yaml"), out, perm); err != nil {
			return nil, fmt.Errorf("hermes: writing config.yaml: %w", err)
		}
	}
	return prior, nil
}

func terminalKeyPaths() []string {
	paths := make([]string, len(terminalKeys))
	for i, k := range terminalKeys {
		paths[i] = "terminal." + k
	}
	return paths
}

// terminalPrior records the section's shape and, for each owned key that exists, its line as
// written, so Restore can put back the operator's exact bytes (quotes, comments and all).
func terminalPrior(config []byte) (map[string]any, map[string]int, error) {
	root, err := configRoot(config)
	if err != nil {
		return nil, nil, err
	}
	at := map[string]int{}
	lines := strings.Split(string(config), "\n")
	prior := map[string]any{priorEOFNewline: len(config) == 0 || bytes.HasSuffix(config, []byte("\n"))}
	key, section := mapChild(root, "terminal")
	switch {
	case section == nil:
		prior[priorSection] = "absent"
		return prior, at, nil
	case section.Kind == yaml.ScalarNode && (section.Tag == "!!null" || section.Value == "") &&
		strings.TrimSpace(lineOf(lines, key.Line)) == "terminal:":
		prior[priorSection] = "bare"
		return prior, at, nil
	case section.Kind != yaml.MappingNode || section.Style&yaml.FlowStyle != 0:
		return nil, nil, errors.New("hermes: config.yaml's terminal is not a block mapping; refusing to edit it")
	}
	prior[priorSection] = "mapping"
	for _, k := range terminalKeys {
		kn, vn := mapChild(section, k)
		if vn == nil {
			continue
		}
		if !oneLine(lines, kn, vn) {
			return nil, nil, fmt.Errorf("hermes: config.yaml's terminal.%s is not a one-line setting; refusing to edit it", k)
		}
		prior[k] = lineOf(lines, kn.Line)
		at[k] = kn.Line
	}
	return prior, at, nil
}

// scalarLine is raw's key line holding v instead, at raw's indentation.
func scalarLine(raw, key string, v any) (string, error) {
	text, err := yaml.Marshal(v)
	if err != nil {
		return "", err
	}
	value := strings.TrimSuffix(string(text), "\n")
	if strings.Contains(value, "\n") {
		return "", fmt.Errorf("hermes: terminal.%s does not fit on one line", key)
	}
	return raw[:len(raw)-len(strings.TrimLeft(raw, " \t"))] + key + ": " + value, nil
}

// Restore puts the owned lines back when they still hold what SetSSH wrote.
func (HermesTerminal) Restore(profileDir string, wrote SSHTerminal, prior map[string]any) (bool, error) {
	config, perm, err := readConfig(profileDir)
	if err != nil {
		return false, err
	}
	out, changed, err := restoreTerminal(config, wrote, prior)
	if err != nil || changed {
		return changed, err
	}
	// Restored first: it is the side that may lack the section SetSSH created, and the check
	// treats a section only `before` lacks as one the edit made.
	if err := configedit.SameOutsideKeys(out, config, terminalKeyPaths(), nil); err != nil {
		return false, fmt.Errorf("hermes: refusing to restore config.yaml: %w", err)
	}
	if !bytes.Equal(out, config) {
		if err := hostfs.AtomicWriteFile(filepath.Join(profileDir, "config.yaml"), out, perm); err != nil {
			return false, fmt.Errorf("hermes: writing config.yaml: %w", err)
		}
	}
	return false, nil
}

func restoreTerminal(config []byte, wrote SSHTerminal, prior map[string]any) ([]byte, bool, error) {
	sectionState, _ := prior[priorSection].(string)
	if sectionState != "absent" && sectionState != "bare" && sectionState != "mapping" {
		return nil, false, errors.New("hermes: restore record is malformed")
	}
	root, err := configRoot(config)
	if err != nil {
		return nil, false, err
	}
	lines := strings.Split(string(config), "\n")
	_, section := mapChild(root, "terminal")
	if section == nil || section.Kind != yaml.MappingNode || section.Style&yaml.FlowStyle != 0 {
		return nil, true, nil
	}
	want := wrote.values()
	type edit struct {
		line int
		text *string // nil deletes the line
	}
	var edits []edit
	for _, k := range terminalKeys {
		kn, vn := mapChild(section, k)
		if vn == nil || !oneLine(lines, kn, vn) || !sameScalar(vn, want[k]) {
			return nil, true, nil
		}
		if raw, ok := prior[k].(string); ok {
			edits = append(edits, edit{kn.Line, &raw})
		} else {
			edits = append(edits, edit{kn.Line, nil})
		}
	}
	sort.Slice(edits, func(i, j int) bool { return edits[i].line > edits[j].line })
	for _, e := range edits {
		if e.text != nil {
			lines[e.line-1] = *e.text
		} else {
			lines = append(lines[:e.line-1], lines[e.line:]...)
		}
	}
	out := []byte(strings.Join(lines, "\n"))
	if sectionState == "absent" {
		out, err = dropEmptySection(out)
		if err != nil {
			return nil, false, err
		}
		if eof, _ := prior[priorEOFNewline].(bool); !eof && bytes.HasSuffix(out, []byte("\n")) {
			out = out[:len(out)-1]
		}
	}
	return out, false, nil
}

// dropEmptySection removes the `terminal:` line SetSSH appended, once nothing is left under it.
// If someone has since added a key of their own, the section stays.
func dropEmptySection(config []byte) ([]byte, error) {
	root, err := configRoot(config)
	if err != nil {
		return nil, err
	}
	key, section := mapChild(root, "terminal")
	if section == nil || section.Kind != yaml.ScalarNode || (section.Tag != "!!null" && section.Value != "") {
		return config, nil
	}
	lines := strings.Split(string(config), "\n")
	if strings.TrimSpace(lineOf(lines, key.Line)) != "terminal:" {
		return config, nil
	}
	lines = append(lines[:key.Line-1], lines[key.Line:]...)
	return []byte(strings.Join(lines, "\n")), nil
}

func sameScalar(n *yaml.Node, want any) bool {
	if n.Kind != yaml.ScalarNode {
		return false
	}
	switch w := want.(type) {
	case int:
		var got int
		return n.Decode(&got) == nil && got == w
	case string:
		var got string
		return n.Decode(&got) == nil && got == w
	}
	return false
}

// oneLine reports whether a scalar sits wholly on its key's line.
func oneLine(lines []string, k, v *yaml.Node) bool {
	if v.Kind != yaml.ScalarNode || k.Line != v.Line || v.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
		return false
	}
	indent := len(lineOf(lines, k.Line)) - len(strings.TrimLeft(lineOf(lines, k.Line), " \t"))
	next := lineOf(lines, k.Line+1)
	trimmed := strings.TrimLeft(next, " \t")
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return true
	}
	return len(next)-len(trimmed) <= indent
}

func configRoot(config []byte) (*yaml.Node, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal(config, &doc); err != nil {
		return nil, fmt.Errorf("hermes: config.yaml is not valid YAML: %w", err)
	}
	if doc.Kind == 0 {
		return &yaml.Node{Kind: yaml.MappingNode}, nil
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("hermes: config.yaml is not a mapping; refusing to edit it")
	}
	return doc.Content[0], nil
}

func mapChild(parent *yaml.Node, key string) (*yaml.Node, *yaml.Node) {
	for i := 0; i+1 < len(parent.Content); i += 2 {
		if parent.Content[i].Value == key {
			return parent.Content[i], parent.Content[i+1]
		}
	}
	return nil, nil
}

func lineOf(lines []string, n int) string {
	if n < 1 || n > len(lines) {
		return ""
	}
	return lines[n-1]
}

// WriteState records the attachment for the agentpod-live plugin, 0600.
func (HermesTerminal) WriteState(profileDir string, s BenchState) error {
	s.Version = 1
	s.ValidBefore = s.ValidBefore.UTC() // the plugin reads a Z time
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := hostfs.AtomicWriteFile(filepath.Join(profileDir, BenchStateFile), append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("hermes: writing %s: %w", BenchStateFile, err)
	}
	return nil
}

// RemoveState removes the plugin's attach state; absent is fine.
func (HermesTerminal) RemoveState(profileDir string) error {
	if err := os.Remove(filepath.Join(profileDir, BenchStateFile)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("hermes: removing %s: %w", BenchStateFile, err)
	}
	return nil
}
