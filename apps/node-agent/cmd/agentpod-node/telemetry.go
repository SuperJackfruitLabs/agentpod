package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

// probeTimeout bounds the collector probe `apn telemetry status` makes.
const probeTimeout = 2 * time.Second

const macOSTelemetryUnsupported = "telemetry configuration is unsupported on macOS (launchd has no env-file hook)"

// probeFunc asks a collector endpoint whether it answers. Any HTTP response counts as
// answering (the status code is returned); a connection error or timeout is an error.
type probeFunc func(endpoint string) (status int, err error)

// httpProbe returns a probeFunc that sends one GET to <endpoint>/v1/traces. A collector
// typically replies 405 to a GET there, which still proves it is listening.
func httpProbe(timeout time.Duration) probeFunc {
	client := &http.Client{
		Timeout: timeout,
		// A redirect is itself an answer; do not chase it somewhere else.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	return func(endpoint string) (int, error) {
		resp, err := client.Get(strings.TrimRight(endpoint, "/") + "/v1/traces")
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
}

// telemetryCmd implements `apn telemetry <status|enable|disable>`. mgr, out and probe are
// injected so tests never touch systemd or the network.
func telemetryCmd(mgr service.Manager, args []string, out io.Writer, probe probeFunc) int {
	if len(args) == 0 {
		fmt.Fprintln(out, "usage: apn telemetry <status|enable|disable>")
		return 2
	}
	verb, rest := args[0], args[1:]
	switch verb {
	case "-h", "--help":
		fmt.Fprintln(out, commandHelp("telemetry"))
		return 0
	case "status", "enable", "disable":
	default:
		fmt.Fprintln(out, "usage: apn telemetry <status|enable|disable>")
		return 2
	}

	fs := flag.NewFlagSet("telemetry "+verb, flag.ContinueOnError)
	fs.SetOutput(out)
	fs.Usage = func() {
		fmt.Fprintln(out, commandHelp("telemetry"))
		fs.PrintDefaults()
	}
	var jsonOut *bool
	var endpoint *string
	switch verb {
	case "status":
		jsonOut = fs.Bool("json", false, "machine-readable JSON output")
	case "enable":
		endpoint = fs.String("endpoint", "", "OTLP/HTTP collector base URL (http or https)")
	}
	if err := fs.Parse(rest); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}

	path, err := mgr.OTelEnvPath()
	if errors.Is(err, otelenv.ErrUnsupported) {
		fmt.Fprintln(out, "error:", macOSTelemetryUnsupported)
		return 1
	}
	if err != nil {
		fmt.Fprintln(out, "error: resolving the telemetry config path:", err)
		return 1
	}

	switch verb {
	case "status":
		return telemetryStatus(path, *jsonOut, out, probe)
	case "enable":
		changed, err := otelenv.SetEndpoint(path, *endpoint)
		if err != nil {
			fmt.Fprintln(out, "error:", err)
			if *endpoint == "" {
				fmt.Fprintln(out, "usage: apn telemetry enable --endpoint <url>")
			}
			return 1
		}
		if !changed {
			fmt.Fprintf(out, "telemetry already enabled for %s (unchanged, no restart)\n", strings.TrimRight(*endpoint, "/"))
			return 0
		}
		fmt.Fprintf(out, "telemetry enabled: %s (%s)\n", strings.TrimRight(*endpoint, "/"), path)
		return restartAfterTelemetry(mgr, out)
	default: // disable
		changed, err := otelenv.Disable(path)
		if err != nil {
			fmt.Fprintln(out, "error:", err)
			return 1
		}
		if !changed {
			fmt.Fprintln(out, "telemetry already disabled (unchanged, no restart)")
			return 0
		}
		fmt.Fprintf(out, "telemetry disabled (%s)\n", path)
		return restartAfterTelemetry(mgr, out)
	}
}

func restartAfterTelemetry(mgr service.Manager, out io.Writer) int {
	if err := mgr.Restart(); err != nil {
		fmt.Fprintln(out, "error: config written but the service restart failed:", err)
		fmt.Fprintln(out, "restart it manually:", mgr.RestartHint())
		return 1
	}
	fmt.Fprintln(out, "service restarted")
	return 0
}

type telemetryProbeResult struct {
	Answers bool   `json:"answers"`
	Status  int    `json:"status,omitempty"`
	Error   string `json:"error,omitempty"`
}

func telemetryStatus(path string, jsonOut bool, out io.Writer, probe probeFunc) int {
	st, err := otelenv.Read(path)
	if err != nil {
		fmt.Fprintln(out, "error:", err)
		return 1
	}
	var res *telemetryProbeResult
	if st.Enabled {
		res = &telemetryProbeResult{}
		code, perr := probe(st.Endpoint)
		if perr != nil {
			res.Error = perr.Error()
		} else {
			res.Answers, res.Status = true, code
		}
	}

	if jsonOut {
		b, err := json.MarshalIndent(struct {
			Path     string                `json:"path"`
			Endpoint string                `json:"endpoint"`
			Enabled  bool                  `json:"enabled"`
			Probe    *telemetryProbeResult `json:"probe,omitempty"`
		}{path, st.Endpoint, st.Enabled, res}, "", "  ")
		if err != nil {
			fmt.Fprintln(out, "error:", err)
			return 1
		}
		fmt.Fprintln(out, string(b))
		return 0
	}

	state := "disabled"
	if st.Enabled {
		state = "enabled"
	}
	statusLine(out, "config:", path)
	if st.Endpoint != "" {
		statusLine(out, "endpoint:", st.Endpoint)
	} else {
		statusLine(out, "endpoint:", "(none)")
	}
	statusLine(out, "telemetry:", state)
	if res != nil {
		if res.Answers {
			statusLine(out, "collector:", fmt.Sprintf("answers (HTTP %d)", res.Status))
		} else {
			statusLine(out, "collector:", "not answering ("+res.Error+")")
		}
	}
	return 0
}

// applyEnrollOTLP applies `apn enroll --otlp-endpoint` through the same otelenv code as
// `apn telemetry enable`, without restarting (install.sh installs the service afterwards).
// An empty endpoint is a no-op. It returns false only when the endpoint could not be
// applied; macOS (no env-file hook) warns and returns true so enrollment still proceeds.
func applyEnrollOTLP(mgr service.Manager, endpoint string, out io.Writer) bool {
	if endpoint == "" {
		return true
	}
	path, err := mgr.OTelEnvPath()
	if errors.Is(err, otelenv.ErrUnsupported) {
		fmt.Fprintln(out, "warning: --otlp-endpoint ignored:", macOSTelemetryUnsupported)
		return true
	}
	if err != nil {
		fmt.Fprintln(out, "warning: could not resolve the telemetry config path:", err)
		return false
	}
	changed, err := otelenv.SetEndpoint(path, endpoint)
	if err != nil {
		fmt.Fprintln(out, "warning: could not apply --otlp-endpoint:", err)
		return false
	}
	if changed {
		fmt.Fprintf(out, "telemetry endpoint set to %s (%s)\n", strings.TrimRight(endpoint, "/"), path)
	}
	return true
}
