package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
)

// TranscriptionConfig is a station's resolved voice-note transcription
// setting, as the hub hands it to this node.
//
// SECURITY: APIKey must never be logged, folded into an error string, or
// returned in a verb result. It exists to be written into the harness
// profile and nowhere else.
type TranscriptionConfig struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
}

// TranscriptionFetcher reads a station's current transcription setting from
// the hub. stationId is the station's DATABASE id — what the hub's endpoint
// is keyed by — not the station key.
type TranscriptionFetcher func(ctx context.Context, stationId string) (TranscriptionConfig, error)

// NewHTTPTranscriptionFetcher returns the production TranscriptionFetcher: a
// POST to the hub's node-facing transcription endpoint, authenticated with
// this node's own `Bearer <nodeId>:<nodeSecret>` credential — the same scheme
// NewHTTPCredentialFetcher uses for matrix.adopt. The key travels over this
// authenticated HTTP call, never in a broker frame.
func NewHTTPTranscriptionFetcher(hub, nodeID, nodeSecret string) TranscriptionFetcher {
	base := strings.TrimSuffix(hub, "/")
	return func(ctx context.Context, stationId string) (TranscriptionConfig, error) {
		u := base + "/api/nodes/" + url.PathEscape(nodeID) + "/stations/" + url.PathEscape(stationId) + "/transcription"
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
		if err != nil {
			return TranscriptionConfig{}, fmt.Errorf("transcription.apply: building request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+nodeID+":"+nodeSecret)

		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return TranscriptionConfig{}, fmt.Errorf("transcription.apply: could not reach the hub: %w", err)
		}
		defer res.Body.Close()

		if res.StatusCode != http.StatusOK {
			// Drain and discard: the body is never read into an error.
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
			return TranscriptionConfig{}, fmt.Errorf("transcription.apply: hub refused the request (status %d)", res.StatusCode)
		}

		var cfg TranscriptionConfig
		if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&cfg); err != nil {
			// Not wrapped: a decoder error can quote the body it choked on,
			// and this body carries the key.
			return TranscriptionConfig{}, errors.New("transcription.apply: the hub's response did not decode")
		}
		return cfg, nil
	}
}

// TranscriptionWriteFunc writes cfg into the harness profile at profileDir.
// descriptor.WriteHermesSTT in production, adapted by the caller so this
// package stays free of a descriptor import.
type TranscriptionWriteFunc func(profileDir string, cfg TranscriptionConfig) error

// TranscriptionApplyDeps is everything the transcription.apply verb needs.
type TranscriptionApplyDeps struct {
	// Resolver resolves a station key to its profile directory (for Hermes,
	// ~/.hermes or ~/.hermes/profiles/<name>).
	Resolver WorkspaceResolver
	// HarnessFor resolves a station key to its harness name.
	HarnessFor func(key string) (string, error)
	// CapabilitiesFor resolves what the station currently advertises; the
	// restart happens only when that includes "lifecycle".
	CapabilitiesFor CapabilityLookupFunc
	// Fetch reads the station's setting from the hub; see
	// NewHTTPTranscriptionFetcher.
	Fetch TranscriptionFetcher
	// Write puts the setting into the profile.
	Write TranscriptionWriteFunc
	// Restart performs the lifecycle "restart" for key.
	Restart func(key string) error
}

// transcriptionHarnesses are the harnesses with a profile writer for this
// verb. Hermes only: it is the harness-mode Matrix client on the fleet, and
// the one whose STT config shape is known.
var transcriptionHarnesses = map[string]bool{"hermes": true}

// transcriptionApplyResult is the verb's answer — VERB_RESULTS
// ["transcription.apply"] in the contract. No url, no key.
type transcriptionApplyResult struct {
	Applied   bool    `json:"applied"`
	Mode      string  `json:"mode"`
	Model     *string `json:"model"`
	Restarted bool    `json:"restarted"`
}

// transcriptionApplyHandler wraps an inner Handler and adds
// transcription.apply: fetch the station's resolved voice-note setting from
// the hub, write it into the harness profile, and restart the harness when
// this node may.
//
// A harness-mode station runs its own Matrix client and transcribes voice
// notes itself, so the hub's setting reaches it only by being written into
// its profile. Order matters as it does for matrix.adopt: write, THEN
// restart — a restart first reloads the old config.
type transcriptionApplyHandler struct {
	inner Handler
	deps  TranscriptionApplyDeps
}

// NewTranscriptionApplyHandler wraps inner with the transcription.apply verb.
func NewTranscriptionApplyHandler(inner Handler, deps TranscriptionApplyDeps) Handler {
	return &transcriptionApplyHandler{inner: inner, deps: deps}
}

// Handle intercepts "transcription.apply" and delegates every other verb.
func (h *transcriptionApplyHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "transcription.apply" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	var p struct {
		Key       string `json:"key"`
		StationID string `json:"stationId"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Key == "" || p.StationID == "" {
		return nil, false, fmt.Errorf("transcription.apply: bad params: missing key or stationId")
	}

	harness, err := h.deps.HarnessFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("transcription.apply: %q: %w", p.Key, err)
	}
	// Refuse before the hub is asked for a key this node has nowhere to put.
	if !transcriptionHarnesses[harness] {
		return nil, false, fmt.Errorf("transcription.apply: %q: harness %q has no transcription profile writer (only hermes is supported)", p.Key, harness)
	}

	caps, err := h.deps.CapabilitiesFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("transcription.apply: %q: capabilities: %w", p.Key, err)
	}
	canRestart := hasCapability(caps, "lifecycle")

	profileDir, err := h.deps.Resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("transcription.apply: %q: profile dir: %w", p.Key, err)
	}

	cfg, err := h.deps.Fetch(ctx, p.StationID)
	if err != nil {
		return nil, false, fmt.Errorf("transcription.apply: %q: %w", p.Key, err)
	}

	if err := h.deps.Write(profileDir, cfg); err != nil {
		return nil, false, fmt.Errorf("transcription.apply: %q: writing profile: %w", p.Key, err)
	}

	res := transcriptionApplyResult{Applied: true, Mode: "off"}
	if cfg.Enabled {
		res.Mode = "on"
		if cfg.Model != "" {
			m := cfg.Model
			res.Model = &m
		}
	}

	if !canRestart {
		// Unlike matrix.adopt this is not a refusal: an STT setting is safe to
		// write into a profile that shares the root gateway (issue #273). It
		// takes effect when that gateway next restarts, which is not this
		// verb's to do.
		log.Printf(
			"gateway: transcription.apply wrote station %q's transcription setting (%s) but did not "+
				"restart it: it has no \"lifecycle\" capability — a Hermes profile sharing the root "+
				"gateway (#273) picks it up when that gateway restarts",
			p.Key, res.Mode,
		)
		return res, false, nil
	}

	if err := h.deps.Restart(p.Key); err != nil {
		return nil, false, fmt.Errorf(
			"transcription.apply: %q: the transcription setting IS written to the profile, but the "+
				"harness could not be restarted to pick it up: %w", p.Key, err)
	}
	res.Restarted = true
	log.Printf("gateway: transcription.apply wrote station %q's transcription setting (%s) and restarted it", p.Key, res.Mode)
	return res, false, nil
}

// HandleFrame forwards inbound terminal/ACP input frames to the inner
// handler, as matrixAdoptHandler does — a wrapper that dropped this would
// silently eat every keystroke below it.
func (h *transcriptionApplyHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
