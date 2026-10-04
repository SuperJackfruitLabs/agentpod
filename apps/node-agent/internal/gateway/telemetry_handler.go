package gateway

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry"
)

// telemetryHandler wraps an inner Handler and answers the "telemetry.status" and
// "telemetry.set" verbs, letting the hub configure the node's OpenTelemetry endpoint
// without SSH. All file logic lives in internal/otelenv (the same code `apn telemetry`
// runs). Like updateHandler it answers first and then exits after a delay so the
// supervisor restarts the node with the new environment — but only when the file
// content actually changed.
type telemetryHandler struct {
	inner Handler
	// path resolves the otel.env path per call; an error (including
	// otelenv.ErrUnsupported) is answered as "unsupported".
	path func() (string, error)
	// effective is the endpoint this process started exporting to (telemetry.FromEnv: ""
	// when off), which differs from the file until the next restart.
	effective string
	exit      func(int)
	delay     time.Duration
	// unit checks the installed systemd unit: apply=false is a read-only dry run,
	// apply=true re-renders a stale unit. nil means "n/a".
	unit func(apply bool) (state, detail string)

	// mu serialises status/set so concurrent requests cannot interleave a
	// read-modify-write of the file.
	mu sync.Mutex
}

// NewTelemetryHandler wraps inner with handlers for telemetry.status / telemetry.set.
// path is called lazily on every request; any error (otelenv.ErrUnsupported,
// otelenv.ErrNotService, ...) makes both verbs answer "unsupported" without touching the
// file or exiting. unit (nil allowed) reports/heals the systemd unit; the gateway
// stays free of systemd specifics.
func NewTelemetryHandler(inner Handler, path func() (string, error), unit func(apply bool) (string, string)) Handler {
	return &telemetryHandler{
		inner:     inner,
		path:      path,
		unit:      unit,
		effective: telemetry.FromEnv("", os.Getenv).Endpoint,
		exit:      os.Exit,
		delay:     time.Second,
	}
}

func (h *telemetryHandler) Handle(
	ctx context.Context,
	verb string,
	p json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "telemetry.status" && verb != "telemetry.set" {
		return h.inner.Handle(ctx, verb, p, emit)
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	path, err := h.path()
	if err != nil {
		return map[string]any{
			"ok":          false,
			"unsupported": true,
			"error":       err.Error(),
		}, false, nil
	}

	if verb == "telemetry.status" {
		st, err := otelenv.Read(path)
		if err != nil {
			return telemetryFail(err), false, nil
		}
		res := map[string]any{
			"ok":        true,
			"path":      path,
			"endpoint":  st.Endpoint,
			"enabled":   st.Enabled,
			"effective": h.effective,
		}
		us, ud := h.checkUnit(false)
		unitFields(res, us, ud)
		return res, false, nil
	}

	// telemetry.set: exactly one of a non-empty endpoint or off:true.
	var params struct {
		Endpoint *string `json:"endpoint"`
		Off      *bool   `json:"off"`
	}
	if err := json.Unmarshal(p, &params); err != nil {
		return map[string]any{"ok": false, "error": "invalid params: " + err.Error()}, false, nil
	}
	// Presence counts: an empty endpoint or "off":false is malformed, not "absent",
	// so a request that mixes the two shapes is refused rather than half-honoured.
	wantEndpoint := params.Endpoint != nil
	wantOff := params.Off != nil
	if wantEndpoint == wantOff || (wantEndpoint && *params.Endpoint == "") || (wantOff && !*params.Off) {
		return map[string]any{"ok": false, "error": `params must have exactly one of "endpoint" (non-empty string) or "off":true`}, false, nil
	}

	// Heal a pre-#659 unit first so the env file written below is one systemd passes.
	unitState, unitDetail := h.checkUnit(true)

	var changed bool
	if wantOff {
		changed, err = otelenv.Disable(path)
	} else {
		changed, err = otelenv.SetEndpoint(path, *params.Endpoint)
	}
	if err != nil {
		return telemetryFail(err), false, nil
	}
	st, err := otelenv.Read(path)
	if err != nil {
		return telemetryFail(err), false, nil
	}

	restart := changed || unitState == "reconciled"
	if restart {
		// Respond before exiting so the dispatcher can write the response frame.
		go func() {
			time.Sleep(h.delay)
			h.exit(0)
		}()
	}
	res := map[string]any{
		"ok":         true,
		"changed":    changed,
		"endpoint":   st.Endpoint,
		"enabled":    st.Enabled,
		"restarting": restart,
	}
	unitFields(res, unitState, unitDetail)
	return res, false, nil
}

func (h *telemetryHandler) checkUnit(apply bool) (string, string) {
	if h.unit == nil {
		return "n/a", ""
	}
	return h.unit(apply)
}

func unitFields(res map[string]any, state, detail string) {
	res["unit"] = state
	if detail != "" {
		res["unitDetail"] = detail
	}
}

func telemetryFail(err error) map[string]any {
	return map[string]any{"ok": false, "error": err.Error()}
}

// HandleFrame forwards inbound terminal frames to the inner handler (see
// updateHandler.HandleFrame for why wrappers must do this).
func (h *telemetryHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
