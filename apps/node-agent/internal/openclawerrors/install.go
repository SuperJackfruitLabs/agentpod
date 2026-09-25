// Package openclawerrors installs the agentpod-errors OpenClaw plugin on this
// host: `apn openclaw-errors`.
//
// The plugin reports why an OpenClaw turn failed to this node's turn-error
// intake (internal/turnerror), because OpenClaw's ACP bridge drops the
// provider's words. Installing it is an operator action like `apn
// hermes-live`: the command shows exactly what it would change, writes nothing
// without --apply, backs up the configuration it edits, and never restarts the
// gateway — loading a plugin needs a restart, and that stays the operator's
// call, because one OpenClaw gateway serves every agent on the machine.
//
// What it writes, and nothing else:
//   - the plugin's files, into ~/.agentpod/openclaw/agentpod-errors (apn's own
//     directory, so an OpenClaw upgrade or `openclaw plugins` never touches it)
//   - in ~/.openclaw/openclaw.json: that directory in plugins.load.paths, and
//     plugins.entries.agentpod-errors = enabled, with
//     hooks.allowConversationAccess — OpenClaw blocks agent_end for a
//     non-bundled plugin without it.
//
// These are exactly the settings the plugin's contract test runs a real
// OpenClaw with (integrations/openclaw/agentpod-errors/contract).
package openclawerrors

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Name is the plugin's id in OpenClaw and its directory name.
const Name = "agentpod-errors"

//go:embed plugin
var embedded embed.FS

// FileNames lists the plugin's files, in a stable order.
func FileNames() []string {
	entries, _ := fs.ReadDir(embedded, "plugin/"+Name)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

func embeddedFile(name string) []byte {
	b, _ := embedded.ReadFile("plugin/" + Name + "/" + name)
	return b
}

// Version is the plugin version this apn ships.
func Version() string {
	var pkg struct {
		Version string `json:"version"`
	}
	json.Unmarshal(embeddedFile("package.json"), &pkg)
	return pkg.Version
}

// TestedRange is the OpenClaw versions the plugin's contract passed on.
func TestedRange() (min, max string) {
	lo, _ := embedded.ReadFile("plugin/openclaw-tested.min")
	hi, _ := embedded.ReadFile("plugin/openclaw-tested.max")
	return strings.TrimSpace(string(lo)), strings.TrimSpace(string(hi))
}

// ─── Version gate ────────────────────────────────────────────────────────────

var versionPattern = regexp.MustCompile(`(\d{4})\.(\d+)\.(\d+)(?:-(\d+))?`)

func versionParts(v string) ([4]int, bool) {
	m := versionPattern.FindStringSubmatch(v)
	if m == nil {
		return [4]int{}, false
	}
	var parts [4]int
	for i := 0; i < 4; i++ {
		parts[i], _ = strconv.Atoi(m[i+1])
	}
	return parts, true
}

// CompareVersions orders OpenClaw versions (YYYY.M.D, optionally -N). A
// version without a -N suffix is the one before -1, as OpenClaw numbers them.
func CompareVersions(a, b string) int {
	pa, _ := versionParts(a)
	pb, _ := versionParts(b)
	for i := range pa {
		switch {
		case pa[i] < pb[i]:
			return -1
		case pa[i] > pb[i]:
			return 1
		}
	}
	return 0
}

// Gate is whether this OpenClaw is one the plugin has been proven on.
type Gate struct {
	Allowed bool
	Reason  string
}

// CheckOpenClaw decides from a version probe (status known/absent/undetermined).
// Only a known version inside the tested range passes: the plugin leans on
// agent_end's event shape and a config key, which OpenClaw can change.
func CheckOpenClaw(status, version, reason string) Gate {
	min, max := TestedRange()
	switch status {
	case "absent":
		return Gate{Reason: "OpenClaw is not installed here: " + reason}
	case "known":
	default:
		return Gate{Reason: "the OpenClaw version could not be read (" + reason + "); install held until it can"}
	}
	parts, ok := versionParts(version)
	if !ok {
		return Gate{Reason: fmt.Sprintf("%q is not an OpenClaw version this apn understands", version)}
	}
	v := fmt.Sprintf("%d.%d.%d-%d", parts[0], parts[1], parts[2], parts[3])
	if CompareVersions(v, min) < 0 {
		return Gate{Reason: fmt.Sprintf("OpenClaw %s is older than the oldest tested, %s", version, min)}
	}
	if CompareVersions(v, max) > 0 {
		return Gate{Reason: fmt.Sprintf("OpenClaw %s is newer than the newest tested, %s; the nightly contract run says when a newer one is safe", version, max)}
	}
	return Gate{Allowed: true, Reason: fmt.Sprintf("within the tested range %s to %s", min, max)}
}

// ─── Plan and apply ──────────────────────────────────────────────────────────

// Plan is what enable or disable would do. Nothing is written until Apply.
type Plan struct {
	Action       string // "enable" or "disable"
	Home         string
	PluginDir    string
	ConfigPath   string
	FileAction   string // "add", "replace", "keep", "remove"
	ConfigBefore []byte
	ConfigAfter  []byte
	NoOp         bool
}

// PluginDir is where apn keeps the plugin.
func PluginDir(home string) string { return filepath.Join(home, ".agentpod", "openclaw", Name) }

// ConfigPath is OpenClaw's configuration.
func ConfigPath(home string) string { return filepath.Join(home, ".openclaw", "openclaw.json") }

func filesCurrent(dir string) (present, current bool) {
	current = true
	for _, name := range FileNames() {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			current = false
			continue
		}
		present = true
		if !bytes.Equal(b, embeddedFile(name)) {
			current = false
		}
	}
	return present, current
}

// PlanEnable plans installing and enabling the plugin.
func PlanEnable(home string, gate Gate) (Plan, error) {
	if !gate.Allowed {
		return Plan{}, fmt.Errorf("not installing on this OpenClaw: %s", gate.Reason)
	}
	plan := Plan{Action: "enable", Home: home, PluginDir: PluginDir(home), ConfigPath: ConfigPath(home)}
	before, err := os.ReadFile(plan.ConfigPath)
	if err != nil {
		return Plan{}, fmt.Errorf("no OpenClaw configuration at %s: %w", plan.ConfigPath, err)
	}
	after, err := enableConfig(before, plan.PluginDir)
	if err != nil {
		return Plan{}, fmt.Errorf("%s: %w", plan.ConfigPath, err)
	}
	plan.ConfigBefore, plan.ConfigAfter = before, after

	switch present, current := filesCurrent(plan.PluginDir); {
	case current:
		plan.FileAction = "keep"
	case present:
		plan.FileAction = "replace"
	default:
		plan.FileAction = "add"
	}
	plan.NoOp = plan.FileAction == "keep" && sameJSON(before, after)
	return plan, nil
}

// PlanDisable plans removing the plugin and its configuration.
func PlanDisable(home string) (Plan, error) {
	plan := Plan{Action: "disable", Home: home, PluginDir: PluginDir(home), ConfigPath: ConfigPath(home)}
	before, err := os.ReadFile(plan.ConfigPath)
	if err != nil {
		return Plan{}, fmt.Errorf("no OpenClaw configuration at %s: %w", plan.ConfigPath, err)
	}
	after, err := disableConfig(before, plan.PluginDir)
	if err != nil {
		return Plan{}, fmt.Errorf("%s: %w", plan.ConfigPath, err)
	}
	plan.ConfigBefore, plan.ConfigAfter = before, after
	plan.FileAction = "keep"
	if _, err := os.Stat(plan.PluginDir); err == nil {
		plan.FileAction = "remove"
	}
	plan.NoOp = plan.FileAction == "keep" && sameJSON(before, after)
	return plan, nil
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return bytes.Equal(ja, jb)
}

// Apply carries out a plan. The configuration is backed up beside itself
// before it is changed, and written through a temp file so a crash leaves the
// old one or the new one, never half of each.
func Apply(plan Plan, now time.Time) error {
	if plan.NoOp {
		return nil
	}
	switch plan.FileAction {
	case "add", "replace":
		if err := os.MkdirAll(plan.PluginDir, 0o755); err != nil {
			return err
		}
		for _, name := range FileNames() {
			if err := os.WriteFile(filepath.Join(plan.PluginDir, name), embeddedFile(name), 0o644); err != nil {
				return err
			}
		}
	}

	if !bytes.Equal(plan.ConfigBefore, plan.ConfigAfter) {
		current, err := os.ReadFile(plan.ConfigPath)
		if err != nil {
			return err
		}
		if !bytes.Equal(current, plan.ConfigBefore) {
			return errors.New("the OpenClaw configuration changed since this plan was made; run the command again")
		}
		info, err := os.Stat(plan.ConfigPath)
		if err != nil {
			return err
		}
		mode := info.Mode().Perm()
		backup := plan.ConfigPath + ".bak-" + Name + "-" + now.UTC().Format("20060102T150405Z")
		if err := os.WriteFile(backup, plan.ConfigBefore, mode); err != nil {
			return fmt.Errorf("backing up %s: %w", plan.ConfigPath, err)
		}
		tmp := plan.ConfigPath + ".tmp-" + Name
		if err := os.WriteFile(tmp, plan.ConfigAfter, mode); err != nil {
			return err
		}
		if err := os.Rename(tmp, plan.ConfigPath); err != nil {
			os.Remove(tmp)
			return err
		}
	}

	if plan.FileAction == "remove" {
		return os.RemoveAll(plan.PluginDir)
	}
	return nil
}

// ─── Status ──────────────────────────────────────────────────────────────────

// Status is what is on disk, and whether this node would receive reports.
type Status struct {
	Installed          bool
	Current            bool
	Enabled            bool
	ConversationAccess bool
	LoadPath           bool
	IntakeListening    bool
	IntakePath         string
	ConfigError        string
}

// Observe reads the plugin directory, OpenClaw's configuration, and this
// node's intake socket. It says what is configured, not what the running
// gateway loaded: the gateway reads its configuration at start.
func Observe(home string) Status {
	var st Status
	st.Installed, st.Current = filesCurrent(PluginDir(home))

	if raw, err := os.ReadFile(ConfigPath(home)); err != nil {
		st.ConfigError = err.Error()
	} else {
		var cfg struct {
			Plugins struct {
				Load struct {
					Paths []string `json:"paths"`
				} `json:"load"`
				Entries map[string]struct {
					Enabled bool `json:"enabled"`
					Hooks   struct {
						AllowConversationAccess bool `json:"allowConversationAccess"`
					} `json:"hooks"`
				} `json:"entries"`
			} `json:"plugins"`
		}
		if err := json.Unmarshal(raw, &cfg); err != nil {
			st.ConfigError = err.Error()
		} else {
			for _, p := range cfg.Plugins.Load.Paths {
				if p == PluginDir(home) {
					st.LoadPath = true
				}
			}
			entry, ok := cfg.Plugins.Entries[Name]
			st.Enabled = ok && entry.Enabled && st.LoadPath
			st.ConversationAccess = ok && entry.Hooks.AllowConversationAccess
		}
	}

	st.IntakePath = intakeSocketPath(home)
	if c, err := net.DialTimeout("unix", st.IntakePath, 300*time.Millisecond); err == nil {
		c.Close()
		st.IntakeListening = true
	}
	return st
}

// intakeSocketPath mirrors internal/turnerror.DefaultSocketPath for a given
// home, so status can be asked about any home, as tests do.
func intakeSocketPath(home string) string {
	if p := strings.TrimSpace(os.Getenv("AGENTPOD_TURN_ERROR_SOCKET")); p != "" {
		return p
	}
	return filepath.Join(home, ".agentpod", "turn-errors.sock")
}
