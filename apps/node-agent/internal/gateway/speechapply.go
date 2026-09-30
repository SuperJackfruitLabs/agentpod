package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
)

// SpeechConfig is a station's resolved spoken-reply setting, as the hub
// hands it to this node.
//
// SECURITY: APIKey must never be logged, folded into an error string, or
// returned in a verb result. It exists to be written into the harness
// profile and nowhere else.
type SpeechConfig struct {
	Enabled bool   `json:"enabled"`
	URL     string `json:"url"`
	APIKey  string `json:"apiKey"`
	Voice   string `json:"voice"`
	// SpeakMode is off | voice_in | always.
	SpeakMode string `json:"speakMode"`
}

// SpeechFetcher reads a station's current speech setting from the hub.
// stationId is the station's DATABASE id, not the station key.
type SpeechFetcher func(ctx context.Context, stationId string) (SpeechConfig, error)

// NewHTTPSpeechFetcher returns the production SpeechFetcher: a POST to the
// hub's node-facing speech endpoint with this node's own
// `Bearer <nodeId>:<nodeSecret>` credential, exactly as
// NewHTTPTranscriptionFetcher does. The key travels over this authenticated
// HTTP call, never in a broker frame.
func NewHTTPSpeechFetcher(hub, nodeID, nodeSecret string) SpeechFetcher {
	return func(ctx context.Context, stationId string) (SpeechConfig, error) {
		var cfg SpeechConfig
		err := postNodeStationRead(ctx, hub, nodeID, nodeSecret, stationId, "speech", "speech.apply", &cfg)
		return cfg, err
	}
}

// SpeechWriteFunc writes cfg into the harness profile at profileDir and
// reports whether the harness will now speak every reply on its own.
// descriptor.WriteHermesSpeech in production.
type SpeechWriteFunc func(profileDir string, cfg SpeechConfig) (autoSpeak bool, err error)

// SpeechApplyDeps is everything the speech.apply verb needs; the same seams
// as TranscriptionApplyDeps.
type SpeechApplyDeps struct {
	Resolver        WorkspaceResolver
	HarnessFor      func(key string) (string, error)
	CapabilitiesFor CapabilityLookupFunc
	Fetch           SpeechFetcher
	Write           SpeechWriteFunc
	Restart         func(key string) error
}

// speechHarnesses are the harnesses with a profile writer for this verb.
// Hermes only: OpenClaw stations are bridge-mode, where the hub speaks for
// them, and no other harness is its own Matrix client.
var speechHarnesses = map[string]bool{"hermes": true}

// speechApplyResult is the verb's answer — VERB_RESULTS["speech.apply"] in
// the contract. No url, no key.
type speechApplyResult struct {
	Applied   bool    `json:"applied"`
	Mode      string  `json:"mode"`
	Voice     *string `json:"voice"`
	SpeakMode *string `json:"speakMode"`
	AutoSpeak bool    `json:"autoSpeak"`
	Restarted bool    `json:"restarted"`
}

// speechApplyHandler wraps an inner Handler and adds speech.apply: fetch the
// station's resolved speech setting from the hub, write it into the harness
// profile, and restart the harness when this node may — write, THEN restart,
// as transcription.apply does.
type speechApplyHandler struct {
	inner Handler
	deps  SpeechApplyDeps
}

// NewSpeechApplyHandler wraps inner with the speech.apply verb.
func NewSpeechApplyHandler(inner Handler, deps SpeechApplyDeps) Handler {
	return &speechApplyHandler{inner: inner, deps: deps}
}

// Handle intercepts "speech.apply" and delegates every other verb.
func (h *speechApplyHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "speech.apply" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	var p struct {
		Key       string `json:"key"`
		StationID string `json:"stationId"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Key == "" || p.StationID == "" {
		return nil, false, fmt.Errorf("speech.apply: bad params: missing key or stationId")
	}

	harness, err := h.deps.HarnessFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("speech.apply: %q: %w", p.Key, err)
	}
	// Refuse before the hub is asked for a key this node has nowhere to put.
	if !speechHarnesses[harness] {
		return nil, false, fmt.Errorf("speech.apply: %q: harness %q has no speech profile writer (only hermes is supported)", p.Key, harness)
	}

	caps, err := h.deps.CapabilitiesFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("speech.apply: %q: capabilities: %w", p.Key, err)
	}
	canRestart := hasCapability(caps, "lifecycle")

	profileDir, err := h.deps.Resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("speech.apply: %q: profile dir: %w", p.Key, err)
	}

	cfg, err := h.deps.Fetch(ctx, p.StationID)
	if err != nil {
		return nil, false, fmt.Errorf("speech.apply: %q: %w", p.Key, err)
	}

	autoSpeak, err := h.deps.Write(profileDir, cfg)
	if err != nil {
		return nil, false, fmt.Errorf("speech.apply: %q: writing profile: %w", p.Key, err)
	}

	res := speechApplyResult{Applied: true, Mode: "off", AutoSpeak: autoSpeak}
	if cfg.Enabled {
		res.Mode = "on"
		v, m := cfg.Voice, cfg.SpeakMode
		res.Voice, res.SpeakMode = &v, &m
	}

	if !canRestart {
		log.Printf(
			"gateway: speech.apply wrote station %q's speech setting (%s) but did not restart it: "+
				"it has no \"lifecycle\" capability — a Hermes profile sharing the root gateway (#273) "+
				"picks it up when that gateway restarts",
			p.Key, res.Mode,
		)
		return res, false, nil
	}

	if err := h.deps.Restart(p.Key); err != nil {
		return nil, false, fmt.Errorf(
			"speech.apply: %q: the speech setting IS written to the profile, but the harness could "+
				"not be restarted to pick it up: %w", p.Key, err)
	}
	res.Restarted = true
	log.Printf("gateway: speech.apply wrote station %q's speech setting (%s, autoSpeak %v) and restarted it", p.Key, res.Mode, res.AutoSpeak)
	return res, false, nil
}

// HandleFrame forwards inbound terminal/ACP input frames to the inner
// handler, as every request-only wrapper must.
func (h *speechApplyHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
