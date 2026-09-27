package hermeslive

import (
	"bufio"
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"go.yaml.in/yaml/v3"
)

// Status is what one look at a profile says about the plugin.
type Status struct {
	Present     bool
	Managed     bool
	Files       string
	Version     string
	Current     bool // the files are the ones this apn ships
	Enabled     skills.Observation
	Loaded      skills.Observation
	LastTurn    skills.Observation
	InstalledAt *time.Time
}

// logTail bounds how much of agent.log one observation reads.
const logTail = 512 << 10

// The plugin's own log lines, from integrations/hermes/agentpod-live.
const (
	logRegistered    = "agentpod-live: registered"
	logNotRegistered = "agentpod-live: MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN unset; not registering"
	logTurn          = "agentpod-live: turn "
)

// Observe looks at the plugin in a profile without running Hermes: its files,
// the configuration that enables it, and the gateway's agent.log, which is
// where a load and each turn's outcome are recorded.
func Observe(profileDir string, now time.Time) (skills.Plugin, Status) {
	at := now.UTC().Format(time.RFC3339Nano)
	st := Status{}
	state, _ := readState(profileDir)
	st.Managed = state != nil
	files, digest, err := filesState(profileDir, state)
	if err == nil {
		st.Files = files
	}
	st.Present = err == nil && files != FilesAbsent
	st.Current = files == FilesCurrent || files == FilesUnmanagedIdentical
	var since time.Time
	if state != nil {
		if t, err := time.Parse(time.RFC3339, state.InstalledAt); err == nil {
			since = t
			st.InstalledAt = &t
		}
	} else if info, err := os.Stat(pluginDir(profileDir)); err == nil {
		since = info.ModTime()
	}
	if data, err := os.ReadFile(filepath.Join(pluginDir(profileDir), "plugin.yaml")); err == nil {
		if m, err := ParseManifest(data); err == nil {
			st.Version = m.Version
		}
	}
	st.Enabled = enabledObservation(profileDir, at)
	st.Loaded, st.LastTurn = logObservations(profileDir, since, at)

	present := observation(st.Present, at, "The plugin directory "+pluginDir(profileDir)+" holds "+map[bool]string{true: "the plugin", false: "nothing"}[st.Present])
	if err != nil {
		present = skills.Observation{Reason: "The plugin directory could not be read: " + err.Error()}
	}
	locator := "unmanaged"
	if st.Managed {
		locator = "apn-managed"
	}
	source := skills.Source{Kind: "plugin", Locator: &locator}
	if st.Version != "" {
		version := st.Version
		source.Revision = &version
	}
	if len(digest) == 64 {
		d := digest
		source.ArtifactDigest = &d
	}
	plugin := skills.Plugin{
		ID:         "hermes-plugin:" + Name,
		Name:       Name,
		Path:       pluginDir(profileDir),
		Scope:      "profile",
		Source:     source,
		Components: []string{"hooks"},
		Activation: st.Enabled,
		Evidence: skills.Evidence{
			Catalogued: observation(false, at, "Shipped inside apn and installed with `apn hermes-live`, not through the skill catalog"),
			Present:    present,
			Eligible:   skills.Observation{Reason: "Eligibility is decided at install by `apn hermes-live enable` against the Hermes range the CI contract tested"},
			Loaded:     st.Loaded,
			Exercised:  st.LastTurn,
		},
	}
	return plugin, st
}

func enabledObservation(profileDir, at string) skills.Observation {
	data, err := os.ReadFile(configPath(profileDir))
	if err != nil {
		return skills.Observation{Reason: "The profile configuration could not be read: " + err.Error()}
	}
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return skills.Observation{Reason: "The profile configuration is not valid YAML"}
	}
	if listHasValue(pluginsValue(doc, "disabled"), Name) {
		return observation(false, at, "plugins.disabled names "+Name)
	}
	if !listHasValue(pluginsValue(doc, "enabled"), Name) {
		return observation(false, at, "plugins.enabled does not name "+Name)
	}
	if pluginsValue(doc, "stream_reasoning_deltas") != true {
		return observation(true, at, "plugins.enabled names "+Name+"; plugins.stream_reasoning_deltas is not true, so reasoning will not stream")
	}
	return observation(true, at, "plugins.enabled names "+Name+" and plugins.stream_reasoning_deltas is true")
}

// logObservations reads the end of the profile's agent.log. Only lines at or
// after since count: a load before this install says nothing about it.
func logObservations(profileDir string, since time.Time, at string) (skills.Observation, skills.Observation) {
	unknownLoad := skills.Observation{Reason: "No gateway start has logged " + Name + " since it was installed; restart the profile's gateway to load it"}
	unknownTurn := skills.Observation{Reason: "No turn has streamed since the plugin was installed"}
	lines, err := tail(filepath.Join(profileDir, "logs", "agent.log"), logTail)
	if err != nil {
		reason := "The gateway log " + filepath.Join(profileDir, "logs", "agent.log") + " could not be read"
		return skills.Observation{Reason: reason}, skills.Observation{Reason: reason}
	}
	loaded, turn := unknownLoad, unknownTurn
	for _, line := range lines {
		when, message, ok := parseLogLine(line)
		if !ok || (!since.IsZero() && when.Before(since.Truncate(time.Second))) {
			continue
		}
		stamp := when.UTC().Format(time.RFC3339Nano)
		switch {
		case strings.HasPrefix(message, logRegistered):
			loaded = skills.Observation{Value: boolPtr(true), ObservedAt: &stamp, Reason: "The gateway logged `" + message + "`"}
		case strings.HasPrefix(message, logNotRegistered):
			loaded = skills.Observation{Value: boolPtr(false), ObservedAt: &stamp, Reason: "The gateway loaded the plugin without MATRIX_HOMESERVER or MATRIX_ACCESS_TOKEN, so it registered no hooks"}
		case strings.HasPrefix(message, logTurn) && strings.Contains(message, " sent "):
			ok := !strings.Contains(message, "send(s) failed")
			turn = skills.Observation{Value: boolPtr(ok), ObservedAt: &stamp, Reason: "Last turn: " + strings.TrimPrefix(message, "agentpod-live: ")}
		}
	}
	return loaded, turn
}

// parseLogLine reads Hermes's "<asctime> LEVEL <logger>: <message>" and returns
// the plugin's message. asctime is the host's local time, and this runs on
// that host.
func parseLogLine(line string) (time.Time, string, bool) {
	if len(line) < 23 {
		return time.Time{}, "", false
	}
	when, err := time.ParseInLocation("2006-01-02 15:04:05,000", line[:23], time.Local)
	if err != nil {
		return time.Time{}, "", false
	}
	i := strings.Index(line, "agentpod-live: ")
	if i < 0 {
		return time.Time{}, "", false
	}
	return when, strings.TrimSpace(line[i:]), true
}

func tail(path string, max int64) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	start := info.Size() - max
	if start < 0 {
		start = 0
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(io.LimitReader(f, max))
	if err != nil {
		return nil, err
	}
	if start > 0 {
		// Drop the partial first line.
		if i := bytes.IndexByte(data, '\n'); i >= 0 {
			data = data[i+1:]
		}
	}
	var lines []string
	s := bufio.NewScanner(bytes.NewReader(data))
	s.Buffer(make([]byte, 64<<10), 1<<20)
	for s.Scan() {
		if strings.Contains(s.Text(), "agentpod-live: ") {
			lines = append(lines, s.Text())
		}
	}
	return lines, s.Err()
}

func boolPtr(v bool) *bool { return &v }

func observation(value bool, at, reason string) skills.Observation {
	stamp := at
	return skills.Observation{Value: boolPtr(value), ObservedAt: &stamp, Reason: reason}
}
