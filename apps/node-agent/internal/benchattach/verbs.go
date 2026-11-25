package benchattach

// The hub's remote-bench verbs on the agent's node: `bench.identity.ensure`,
// `bench.remote.attach`, `bench.remote.detach` and `bench.remote.status` (contract
// `packages/contract/src/bench-remote.ts`). Here rather than in internal/gateway, which is at its
// size limit; the handler wraps a gateway.Handler the same way every verb there does.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchidentity"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
)

// AttachCapability is advertised by a node that answers these verbs.
const AttachCapability = "bench.remote.attach"

const (
	VerbEnsure = "bench.identity.ensure"
	VerbAttach = "bench.remote.attach"
	VerbDetach = "bench.remote.detach"
	VerbStatus = "bench.remote.status"
)

// HandlerDeps are the verb handler's seams.
type HandlerDeps struct {
	Root       string
	Manager    Manager
	HarnessFor func(stationKey string) (string, error)
}

type handler struct {
	inner gateway.Handler
	deps  HandlerDeps
}

// NewHandler wraps inner with the remote-bench verbs.
func NewHandler(inner gateway.Handler, deps HandlerDeps) gateway.Handler {
	return &handler{inner: inner, deps: deps}
}

// Credential is the certificate reply SuperBench issued, as the bench host's node relayed it.
// Public material only: the lease token never reaches this node.
type Credential struct {
	Certificate        string `json:"certificate"`
	User               string `json:"user"`
	Address            string `json:"address"`
	HostKey            string `json:"host_key"`
	HostKeyFingerprint string `json:"host_key_fingerprint"`
	LeaseID            string `json:"lease_id"`
	Generation         uint64 `json:"generation"`
	ValidBefore        string `json:"valid_before"`
	WorkingDirectory   string `json:"working_directory"`
}

// Refused is every verb's answer when it changes nothing.
type Refused struct {
	State   string `json:"state"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func refused(code, message string) Refused {
	return Refused{State: "refused", Code: code, Message: message}
}

type ensureParams struct {
	StationID  string `json:"stationId"`
	StationKey string `json:"stationKey"`
}

type attachParams struct {
	StationID  string      `json:"stationId"`
	StationKey string      `json:"stationKey"`
	AttemptID  string      `json:"attemptId"`
	Credential *Credential `json:"credential"`
}

type detachParams struct {
	StationID string `json:"stationId"`
	AttemptID string `json:"attemptId"`
}

type statusParams struct {
	StationID string `json:"stationId"`
}

// StatusReply is bench.remote.status's answer; both fields are absent when nothing is attached.
type StatusReply struct {
	AttemptID   string `json:"attemptId,omitempty"`
	ValidBefore string `json:"validBefore,omitempty"`
}

// strict decodes exactly one JSON object with no field the verb does not define.
func strict(raw json.RawMessage, into any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing data after the params object")
	}
	return nil
}

func (h *handler) Handle(ctx context.Context, verb string, params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error) (any, bool, error) {
	switch verb {
	case VerbEnsure:
		return h.ensure(params), false, nil
	case VerbAttach:
		return h.attach(ctx, params), false, nil
	case VerbDetach:
		return h.detach(ctx, params), false, nil
	case VerbStatus:
		return h.status(params), false, nil
	}
	return h.inner.Handle(ctx, verb, params, emit)
}

func (h *handler) ensure(raw json.RawMessage) any {
	var p ensureParams
	if err := strict(raw, &p); err != nil {
		return refused(CodeInvalid, "bad params: "+err.Error())
	}
	if !benchidentity.ValidStationID(p.StationID) || p.StationKey == "" {
		return refused(CodeInvalid, "stationId and stationKey are required")
	}
	pub, _, _, err := benchidentity.EnsureKey(h.deps.Root, p.StationID, p.StationKey)
	if err != nil {
		return refused("unavailable", err.Error())
	}
	// The key path is never returned: the hub has no use for it.
	return map[string]string{"publicKey": pub}
}

func (h *handler) attach(ctx context.Context, raw json.RawMessage) any {
	var p attachParams
	if err := strict(raw, &p); err != nil {
		return refused(CodeInvalid, "bad params: "+err.Error())
	}
	if p.Credential == nil || p.StationKey == "" {
		return refused(CodeInvalid, "stationKey and credential are required")
	}
	harness, err := h.deps.HarnessFor(p.StationKey)
	if err != nil || harness != "hermes" {
		return refused(CodeHarnessUnsupported, fmt.Sprintf("a remote bench needs a Hermes station; %q is not one", p.StationKey))
	}
	validBefore, err := time.Parse(time.RFC3339Nano, p.Credential.ValidBefore)
	if err != nil {
		return refused(CodeInvalid, "credential.valid_before is not an RFC 3339 time")
	}
	c := p.Credential
	until, err := h.deps.Manager.Attach(ctx, Attachment{
		StationID: p.StationID, StationKey: p.StationKey, AttemptID: p.AttemptID,
		Certificate: c.Certificate, User: c.User, Address: c.Address, HostKey: c.HostKey,
		WorkingDirectory: c.WorkingDirectory, ValidBefore: validBefore,
	})
	if err != nil {
		return refusalOf(err)
	}
	return map[string]string{"state": "attached", "validBefore": until.UTC().Format(time.RFC3339)}
}

func (h *handler) detach(ctx context.Context, raw json.RawMessage) any {
	var p detachParams
	if err := strict(raw, &p); err != nil {
		return refused(CodeInvalid, "bad params: "+err.Error())
	}
	if p.AttemptID == "" {
		return refused(CodeInvalid, "attemptId is required")
	}
	state, err := h.deps.Manager.Detach(ctx, p.StationID, p.AttemptID)
	if err != nil {
		return refusalOf(err)
	}
	return map[string]string{"state": state}
}

func (h *handler) status(raw json.RawMessage) any {
	var p statusParams
	if err := strict(raw, &p); err != nil {
		return refused(CodeInvalid, "bad params: "+err.Error())
	}
	if !benchidentity.ValidStationID(p.StationID) {
		return refused(CodeInvalid, "stationId is required")
	}
	attempt, until, ok := h.deps.Manager.Status(p.StationID)
	if !ok {
		return StatusReply{}
	}
	return StatusReply{AttemptID: attempt, ValidBefore: until.UTC().Format(time.RFC3339)}
}

func refusalOf(err error) Refused {
	var r *Refusal
	if errors.As(err, &r) {
		return refused(r.Code, r.Message)
	}
	return refused("unavailable", err.Error())
}

// HandleFrame forwards, as every wrapping handler must.
func (h *handler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(gateway.FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
