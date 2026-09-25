package hermeslive

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Where things live inside a Hermes profile directory:
//
//	config.yaml                          the profile configuration
//	plugins/agentpod-live/               the plugin, where Hermes discovers it
//	.agentpod/hermes-live.json           what apn installed and changed
//	.agentpod/hermes-live-backups/<ts>/  anything apn moved aside
//	config.yaml.bak-agentpod-live-<ts>   the configuration before enable
const (
	stateDirName  = ".agentpod"
	stateFileName = "hermes-live.json"
	backupDirName = "hermes-live-backups"
)

// State is the record of an apn-managed install. It is what makes disable
// exact: it names the files apn placed and the configuration edit it made.
type State struct {
	Plugin        string       `json:"plugin"`
	Version       string       `json:"version"`
	Digest        string       `json:"digest"`
	InstalledAt   string       `json:"installedAt"`
	ConfigBackup  string       `json:"configBackup,omitempty"`
	ConfigWritten string       `json:"configWritten"`
	Config        ConfigChange `json:"config"`
	Adopted       bool         `json:"adopted,omitempty"`
	Displaced     string       `json:"displaced,omitempty"`
	// PluginsDirCreated records that enable created plugins/, so disable can
	// remove it again when it is left empty.
	PluginsDirCreated bool `json:"pluginsDirCreated,omitempty"`
}

// What the plugin directory holds, relative to what this apn ships.
const (
	FilesAbsent             = "absent"
	FilesCurrent            = "current"             // apn-managed, this version
	FilesManagedOlder       = "managed-other"       // apn-managed, another version
	FilesUnmanagedIdentical = "unmanaged-identical" // copied by hand, byte-identical
	FilesUnmanagedDifferent = "unmanaged-different" // copied by hand or edited since
)

// Plan is one reviewed change. Nothing is written until it is applied, and an
// apply refuses if the profile changed after the plan was made.
type Plan struct {
	Action         string
	ProfileDir     string
	Gate           Gate
	Files          string
	FileAction     string // add, replace, keep, adopt, remove, none
	ConfigBefore   []byte
	ConfigAfter    []byte
	RestoresBackup bool
	Change         ConfigChange
	NoOp           bool
	Notes          []string

	state      *State
	diskDigest string
}

func configPath(profileDir string) string { return filepath.Join(profileDir, "config.yaml") }
func pluginDir(profileDir string) string  { return filepath.Join(profileDir, "plugins", Name) }
func statePath(profileDir string) string {
	return filepath.Join(profileDir, stateDirName, stateFileName)
}

// PlanEnable decides how to install and enable the plugin in profileDir. It
// refuses, with the reason, rather than plan a change it should not make: an
// untested or undetermined Hermes, a profile with no configuration, a plugin
// the operator disabled, or a hand-made copy that differs from this one (unless
// replaceUnmanaged, which sets the copy aside rather than deleting it).
func PlanEnable(profileDir string, gate Gate, replaceUnmanaged bool) (Plan, error) {
	plan := Plan{Action: "enable", ProfileDir: profileDir, Gate: gate}
	if !filepath.IsAbs(profileDir) {
		return plan, fmt.Errorf("hermes-live: the profile directory must be absolute")
	}
	if !gate.Allowed {
		return plan, fmt.Errorf("hermes-live: %s", gate.Reason)
	}
	current, err := os.ReadFile(configPath(profileDir))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// A profile with no configuration is one whose defaults apn has not
			// been asked to change; writing one would be a larger claim.
			return plan, fmt.Errorf("hermes-live: %s has no config.yaml; this command does not create one", profileDir)
		}
		return plan, err
	}
	plan.ConfigBefore = current
	state, err := readState(profileDir)
	if err != nil {
		return plan, err
	}
	plan.state = state
	plan.Files, plan.diskDigest, err = filesState(profileDir, state)
	if err != nil {
		return plan, err
	}
	switch plan.Files {
	case FilesAbsent:
		plan.FileAction = "add"
	case FilesCurrent:
		plan.FileAction = "keep"
	case FilesManagedOlder:
		plan.FileAction = "replace"
		plan.Notes = append(plan.Notes, "Replaces the apn-managed copy of another version; the old files are kept under "+filepath.Join(stateDirName, backupDirName)+".")
	case FilesUnmanagedIdentical:
		plan.FileAction = "adopt"
		plan.Notes = append(plan.Notes, "A hand-installed copy is already byte-identical to this one. It is adopted as apn-managed: disable will remove it and its plugins.enabled entry, and leave plugins.stream_reasoning_deltas as found.")
	case FilesUnmanagedDifferent:
		if !replaceUnmanaged {
			return plan, fmt.Errorf("hermes-live: %s holds a copy that apn did not install and that differs from this one; review it, then rerun with --replace-unmanaged to set it aside and install this version", pluginDir(profileDir))
		}
		plan.FileAction = "replace"
		plan.Notes = append(plan.Notes, "Sets aside the hand-installed copy under "+filepath.Join(stateDirName, backupDirName)+"; disable restores it.")
	}
	after, change, err := planEnableConfig(current)
	if err != nil {
		return plan, err
	}
	plan.ConfigAfter, plan.Change = after, change
	plan.NoOp = plan.FileAction == "keep" && bytes.Equal(after, current) && state != nil
	return plan, nil
}

// PlanDisable decides how to remove the plugin and undo the enable. Only an
// apn-managed install is removed, and only while its files are still exactly
// the ones apn placed.
func PlanDisable(profileDir string) (Plan, error) {
	plan := Plan{Action: "disable", ProfileDir: profileDir}
	state, err := readState(profileDir)
	if err != nil {
		return plan, err
	}
	if state == nil {
		return plan, fmt.Errorf("hermes-live: apn has no record of installing %s in this profile, so there is nothing it can safely remove", Name)
	}
	plan.state = state
	current, err := os.ReadFile(configPath(profileDir))
	if err != nil {
		return plan, err
	}
	plan.ConfigBefore = current
	plan.Files, plan.diskDigest, err = filesState(profileDir, state)
	if err != nil {
		return plan, err
	}
	switch plan.Files {
	case FilesAbsent:
		plan.FileAction = "none"
	case FilesCurrent, FilesManagedOlder:
		plan.FileAction = "remove"
	default:
		return plan, fmt.Errorf("hermes-live: %s changed after apn installed it; it is left for you to review rather than removed", pluginDir(profileDir))
	}
	if state.Displaced != "" {
		plan.Notes = append(plan.Notes, "Restores the hand-installed copy set aside at enable.")
	}
	backup := filepath.Join(profileDir, state.ConfigBackup)
	if state.ConfigBackup != "" && hash(current) == state.ConfigWritten {
		if saved, err := os.ReadFile(backup); err == nil {
			// Nothing changed since enable: put back exactly what was there.
			plan.ConfigAfter, plan.RestoresBackup = saved, true
			return plan, nil
		}
	}
	after, err := planDisableConfig(current, state.Config)
	if err != nil {
		return plan, err
	}
	plan.ConfigAfter = after
	if state.ConfigBackup != "" {
		plan.Notes = append(plan.Notes, "The configuration changed after enable, so only the plugin's own keys are reversed; the backup "+state.ConfigBackup+" is kept.")
	}
	return plan, nil
}

// Apply carries out a reviewed plan.
func Apply(plan Plan, now time.Time) error {
	current, err := os.ReadFile(configPath(plan.ProfileDir))
	if err != nil {
		return err
	}
	if !bytes.Equal(current, plan.ConfigBefore) {
		return fmt.Errorf("%w: the profile configuration changed since it was reviewed", ErrConflict)
	}
	if _, digest, err := filesState(plan.ProfileDir, plan.state); err != nil {
		return err
	} else if digest != plan.diskDigest {
		return fmt.Errorf("%w: the plugin directory changed since it was reviewed", ErrConflict)
	}
	if plan.NoOp {
		return nil
	}
	switch plan.Action {
	case "enable":
		return applyEnable(plan, now)
	case "disable":
		return applyDisable(plan)
	}
	return fmt.Errorf("hermes-live: unknown plan action %q", plan.Action)
}

func applyEnable(plan Plan, now time.Time) error {
	stamp := now.UTC().Format("20060102T150405Z")
	stateDir := filepath.Join(plan.ProfileDir, stateDirName)
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	state := State{Plugin: Name, Version: EmbeddedManifest().Version, Digest: Digest(Files()),
		InstalledAt: now.UTC().Format(time.RFC3339), Config: plan.Change, Adopted: plan.FileAction == "adopt"}
	if prior := plan.state; prior != nil {
		// An upgrade keeps the original enable's record, so a later disable
		// still undoes the edit that enable made.
		state.Displaced, state.ConfigBackup = prior.Displaced, prior.ConfigBackup
		if bytes.Equal(plan.ConfigAfter, plan.ConfigBefore) {
			state.Config = prior.Config
		}
		state.Adopted = state.Adopted || prior.Adopted
		state.PluginsDirCreated = prior.PluginsDirCreated
	}
	// The files end up apn's, so disable removes them and their enable entry;
	// a dangling plugins.enabled entry for a removed plugin helps no one.
	state.Config.EnabledAdded = true

	if !bytes.Equal(plan.ConfigAfter, plan.ConfigBefore) {
		name := "config.yaml.bak-agentpod-live-" + stamp
		if err := writeLike(filepath.Join(plan.ProfileDir, name), plan.ConfigBefore, configPath(plan.ProfileDir)); err != nil {
			return err
		}
		if state.ConfigBackup == "" {
			state.ConfigBackup = name
		}
	}
	switch plan.FileAction {
	case "add", "replace":
		if err := placeFiles(plan, stamp, &state); err != nil {
			return err
		}
	}
	if !bytes.Equal(plan.ConfigAfter, plan.ConfigBefore) {
		if err := writeLike(configPath(plan.ProfileDir), plan.ConfigAfter, configPath(plan.ProfileDir)); err != nil {
			return err
		}
	}
	state.ConfigWritten = hash(plan.ConfigAfter)
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(statePath(plan.ProfileDir), append(data, '\n'), 0o600)
}

// placeFiles stages the plugin beside its destination and renames it into
// place, so Hermes never discovers a half-written plugin. Anything already
// there is moved aside, not deleted.
func placeFiles(plan Plan, stamp string, state *State) error {
	stateDir := filepath.Join(plan.ProfileDir, stateDirName)
	staging, err := os.MkdirTemp(stateDir, "stage-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	staged := filepath.Join(staging, Name)
	if err := os.Mkdir(staged, 0o755); err != nil {
		return err
	}
	for name, data := range Files() {
		target := filepath.Join(staged, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
	}
	if _, err := os.Stat(filepath.Dir(pluginDir(plan.ProfileDir))); err != nil {
		state.PluginsDirCreated = true
	}
	if err := os.MkdirAll(filepath.Dir(pluginDir(plan.ProfileDir)), 0o755); err != nil {
		return err
	}
	if plan.Files != FilesAbsent {
		aside := filepath.Join(stateDir, backupDirName, stamp, Name)
		if err := os.MkdirAll(filepath.Dir(aside), 0o700); err != nil {
			return err
		}
		if err := os.Rename(pluginDir(plan.ProfileDir), aside); err != nil {
			return err
		}
		if plan.Files == FilesUnmanagedDifferent {
			state.Displaced, _ = filepath.Rel(plan.ProfileDir, aside)
		}
	}
	return os.Rename(staged, pluginDir(plan.ProfileDir))
}

func applyDisable(plan Plan) error {
	if !bytes.Equal(plan.ConfigAfter, plan.ConfigBefore) {
		if err := writeLike(configPath(plan.ProfileDir), plan.ConfigAfter, configPath(plan.ProfileDir)); err != nil {
			return err
		}
	}
	if plan.FileAction == "remove" {
		if err := os.RemoveAll(pluginDir(plan.ProfileDir)); err != nil {
			return err
		}
	}
	if d := plan.state.Displaced; d != "" {
		if err := os.Rename(filepath.Join(plan.ProfileDir, d), pluginDir(plan.ProfileDir)); err != nil {
			return err
		}
	}
	if err := os.Remove(statePath(plan.ProfileDir)); err != nil {
		return err
	}
	// Leave no empty directory that enable made. os.Remove refuses a
	// non-empty one, so anything else placed there stays.
	if plan.state.PluginsDirCreated {
		_ = os.Remove(filepath.Dir(pluginDir(plan.ProfileDir)))
	}
	_ = os.Remove(filepath.Join(plan.ProfileDir, stateDirName))
	return nil
}

// ---- observation of the directory -----------------------------------------

func readState(profileDir string) (*State, error) {
	data, err := os.ReadFile(statePath(profileDir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("hermes-live: %s is not a valid install record: %w", statePath(profileDir), err)
	}
	return &s, nil
}

// diskFiles reads the plugin directory, leaving out what Python writes when it
// loads the plugin: that is Hermes's, and changes with every load.
func diskFiles(dir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "__pycache__" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(d.Name(), ".pyc") {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("hermes-live: %s is not a regular file", p)
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(rel)] = data
		return nil
	})
	return files, err
}

func filesState(profileDir string, state *State) (string, string, error) {
	info, err := os.Lstat(pluginDir(profileDir))
	if errors.Is(err, fs.ErrNotExist) {
		return FilesAbsent, "", nil
	}
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return FilesUnmanagedDifferent, "not-a-directory", nil
	}
	files, err := diskFiles(pluginDir(profileDir))
	if err != nil {
		return "", "", err
	}
	digest := Digest(files)
	shipped := Digest(Files())
	switch {
	case state != nil && state.Digest == digest && digest == shipped:
		return FilesCurrent, digest, nil
	case state != nil && state.Digest == digest:
		return FilesManagedOlder, digest, nil
	case digest == shipped:
		return FilesUnmanagedIdentical, digest, nil
	default:
		return FilesUnmanagedDifferent, digest, nil
	}
}

// ---- file helpers -----------------------------------------------------------

func hash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// writeLike writes data atomically at path with the permissions of like.
func writeLike(path string, data []byte, like string) error {
	mode := os.FileMode(0o600)
	if info, err := os.Stat(like); err == nil {
		mode = info.Mode().Perm()
	}
	return writeAtomic(path, data, mode)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".agentpod-live-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err = temporary.Write(data); err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err := os.Chmod(name, mode); err != nil {
		return err
	}
	return os.Rename(name, path)
}

// FileNames lists the plugin's files, for a review.
func FileNames() []string {
	names := []string{}
	for name := range Files() {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
