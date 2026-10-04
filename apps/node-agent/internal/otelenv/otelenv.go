// Package otelenv owns node-agent's otel.env file: the systemd EnvironmentFile that turns
// OpenTelemetry export on or off. It is the single code path behind `apn telemetry`,
// `apn enroll --otlp-endpoint`, `apn service install` and the gateway telemetry verbs, so the
// validation and the file format live in exactly one place.
//
// The file is only ever written with known keys, values are validated so a caller cannot
// inject a second variable or a line break, and every rewrite is atomic (temp file in the
// same directory, fsync, rename), so a crash never leaves a half-written file that systemd
// would then feed to the node.
package otelenv

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	// SystemPath is the system-scope file the system unit reads.
	SystemPath = "/etc/agentpod-node/otel.env"

	keyEndpoint = "OTEL_EXPORTER_OTLP_ENDPOINT"
	keyDisabled = "OTEL_SDK_DISABLED"
)

// ErrUnsupported means this platform has no env-file hook for the service (macOS launchd).
var ErrUnsupported = errors.New("otelenv: telemetry configuration is not supported on this platform (launchd has no environment file)")

// UserPath is the user-scope file the user unit reads: $HOME/.config/agentpod-node/otel.env.
func UserPath(home string) string {
	return filepath.Join(home, ".config", "agentpod-node", "otel.env")
}

// knownKeys are the only variables this package writes or documents.
var knownKeys = map[string]bool{
	keyEndpoint:                          true,
	keyDisabled:                          true,
	"OTEL_TRACES_SAMPLER":                true,
	"OTEL_TRACES_SAMPLER_ARG":            true,
	"OTEL_EXPORTER_OTLP_HEADERS":         true,
	"OTEL_EXPORTER_OTLP_METRICS_TIMEOUT": true,
}

const template = `# agentpod-node telemetry (OpenTelemetry, OTLP/HTTP).
#
# Managed by "apn telemetry enable|disable|status" (and "fleet nodes telemetry").
# Prefer those commands over editing by hand; the service must restart to pick up changes.
# Format: KEY=value, one per line, no quotes, no spaces around "=".
#
# Telemetry is OFF unless an endpoint is set. Base URL of an OTLP/HTTP collector;
# node-agent appends /v1/traces and /v1/metrics itself. http or https only.
# OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
#
# Kill switch: true disables export even when an endpoint is set.
# OTEL_SDK_DISABLED=false
#
# Tuning. Only the variables below take effect, because node-agent passes its own explicit
# options for the endpoint URL, the trace export timeout (10s), trace retry (off) and the
# span queue size (2048), and those override the matching OTEL_* variables. Ignored on
# purpose: OTEL_EXPORTER_OTLP_TIMEOUT / _TRACES_TIMEOUT, OTEL_*_RETRY, OTEL_BSP_*,
# OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES.
#
# Trace sampler (read by the OpenTelemetry SDK): always_on, always_off, traceidratio,
# parentbased_always_on, parentbased_traceidratio, ...
# OTEL_TRACES_SAMPLER=parentbased_always_on
# Sampler argument, e.g. a ratio for the traceidratio samplers.
# OTEL_TRACES_SAMPLER_ARG=1.0
#
# Extra request headers for the collector, as k1=v1,k2=v2 (for example an auth token).
# OTEL_EXPORTER_OTLP_HEADERS=
#
# Metrics export timeout in milliseconds (metrics only; traces use the fixed 10s).
# OTEL_EXPORTER_OTLP_METRICS_TIMEOUT=10000
`

// Template is the commented default file: documents every honoured variable, enables nothing.
func Template() string { return template }

// State is what the file currently configures.
type State struct {
	Endpoint string
	Enabled  bool
}

// EnsureTemplate writes the template (mode 0644, parent directories created) only when path
// does not exist, and reports whether it wrote. It never overwrites.
func EnsureTemplate(path string) (bool, error) {
	if _, err := os.Lstat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return false, nil
		}
		return false, err
	}
	_, werr := f.WriteString(template)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		os.Remove(path)
		return false, werr
	}
	// OpenFile honours the umask; make the mode exact.
	if err := os.Chmod(path, 0o644); err != nil {
		return true, err
	}
	return true, nil
}

// parseLine splits an active "KEY=value" line (optionally "export "-prefixed, value optionally
// quoted). ok is false for comments, blanks and anything that is not an assignment.
func parseLine(line string) (key, val string, ok bool) {
	s := strings.TrimSpace(line)
	if s == "" || s[0] == '#' || s[0] == ';' {
		return "", "", false
	}
	s = strings.TrimSpace(strings.TrimPrefix(s, "export "))
	k, v, found := strings.Cut(s, "=")
	if !found {
		return "", "", false
	}
	v = strings.TrimSpace(v)
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		v = v[1 : len(v)-1]
	}
	return strings.TrimSpace(k), v, true
}

func parseState(content string) State {
	var endpoint string
	disabled := false
	for _, line := range strings.Split(content, "\n") {
		k, v, ok := parseLine(line)
		if !ok {
			continue
		}
		switch k {
		case keyEndpoint:
			endpoint = strings.TrimRight(v, "/")
		case keyDisabled:
			disabled = strings.EqualFold(v, "true")
		}
	}
	return State{Endpoint: endpoint, Enabled: endpoint != "" && !disabled}
}

// Read reports the configured state. A missing file is disabled with an empty endpoint. When
// the SDK kill switch is on the endpoint is still reported but Enabled is false; a commented
// endpoint is not an endpoint. Mirrors telemetry.FromEnv (last assignment wins, as systemd does).
func Read(path string) (State, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, nil
	}
	if err != nil {
		return State{}, err
	}
	return parseState(string(b)), nil
}

// ValidateEndpoint accepts only an http or https URL with a host and nothing that could
// change the meaning of the env-file line it is written into: no whitespace, control or
// non-ASCII characters, no '=' (a second assignment), no quotes, backslash, '$', backtick or
// '#', no credentials, no fragment.
func ValidateEndpoint(s string) error {
	if s == "" {
		return errors.New("endpoint is empty")
	}
	for _, r := range s {
		switch {
		case r <= 0x20 || r >= 0x7f:
			return errors.New("endpoint must not contain whitespace, control or non-ASCII characters")
		case strings.ContainsRune("=\"'`\\$#", r):
			return fmt.Errorf("endpoint must not contain %q", r)
		}
	}
	u, err := url.Parse(s)
	if err != nil {
		return fmt.Errorf("endpoint is not a valid URL: %w", err)
	}
	if sc := strings.ToLower(u.Scheme); sc != "http" && sc != "https" {
		return errors.New("endpoint must be an http:// or https:// URL")
	}
	if u.Hostname() == "" {
		return errors.New("endpoint has no host")
	}
	if u.User != nil {
		return errors.New("endpoint must not contain credentials")
	}
	return nil
}

// SetEndpoint validates endpoint, then atomically rewrites the file so it is the one active
// endpoint (and the SDK kill switch is not on). The file is created from the template when
// absent. It reports whether the content changed; on a refusal the file is not touched.
func SetEndpoint(path, endpoint string) (bool, error) {
	if err := ValidateEndpoint(endpoint); err != nil {
		return false, err
	}
	return rewrite(path, func(lines []string) []string {
		return setEndpointLines(lines, strings.TrimRight(endpoint, "/"))
	})
}

// Disable comments the active endpoint out (the value stays visible in the comment) so
// telemetry is off. Created from the template when absent. It reports whether the content
// changed.
func Disable(path string) (bool, error) {
	return rewrite(path, disableLines)
}

func isEndpointComment(line string) bool {
	s := strings.TrimSpace(line)
	return strings.HasPrefix(s, "#") && strings.HasPrefix(strings.TrimSpace(strings.TrimPrefix(s, "#")), keyEndpoint+"=")
}

func setEndpointLines(lines []string, endpoint string) []string {
	want := keyEndpoint + "=" + endpoint
	out := make([]string, 0, len(lines)+1)
	placed := false
	for _, l := range lines {
		k, v, ok := parseLine(l)
		switch {
		case ok && k == keyEndpoint:
			if !placed {
				if strings.TrimRight(v, "/") == endpoint && strings.TrimSpace(l) == want {
					out = append(out, l)
				} else {
					out = append(out, want)
				}
				placed = true
			}
		case ok && k == keyDisabled && strings.EqualFold(v, "true"):
			out = append(out, "# "+keyDisabled+"=true")
		case !placed && isEndpointComment(l):
			out = append(out, want)
			placed = true
		default:
			out = append(out, l)
		}
	}
	if !placed {
		out = append(out, want)
	}
	return out
}

func disableLines(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		if k, v, ok := parseLine(l); ok && k == keyEndpoint {
			out = append(out, "# "+keyEndpoint+"="+v)
			continue
		}
		out = append(out, l)
	}
	return out
}

func rewrite(path string, edit func([]string) []string) (bool, error) {
	if _, err := EnsureTemplate(path); err != nil {
		return false, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	old := string(b)
	body := strings.TrimSuffix(old, "\n")
	next := strings.Join(edit(strings.Split(body, "\n")), "\n") + "\n"
	if next == old {
		return false, nil
	}
	if err := writeAtomic(path, []byte(next)); err != nil {
		return false, err
	}
	return true, nil
}

// writeAtomic replaces path via a temp file in the same directory: write, fsync, chmod 0644,
// rename. The temp file is removed on any failure.
func writeAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".otel.env.*")
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err = tmp.Write(data); err != nil {
		return err
	}
	if err = tmp.Chmod(0o644); err != nil {
		return err
	}
	if err = tmp.Sync(); err != nil {
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if d, derr := os.Open(dir); derr == nil { // best effort: persist the rename
		d.Sync()
		d.Close()
	}
	return nil
}
