package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
)

// forgeAPIHandler answers `forge.api.deliver|policy|verify|revoke|status`: the hub hands the
// station a sealed forge credential and its policy, and the node keeps stk's broker in step.
//
// Frames are decoded strictly (unknown fields are an error): the contract's params are strict on
// the hub side so that a frame which grows a `token` or `secret` key is refused rather than
// stripped, and the node holds the same line. The credential only ever arrives in `sealed`, and
// only goes to stk's stdin; see internal/forgeapi/service.go.
//
// This handler does not advertise the `forge.api` capability; that is the capability builder's
// job, so that it is only claimed when stk is usable.
type forgeAPIHandler struct {
	inner Handler
	svc   ForgeAPI
}

// ForgeAPI is what the handler needs: the five verbs. forgeapi.StationInstances is the node's
// implementation (it routes each frame to its station's own stk instance); a single
// forgeapi.Service satisfies it too.
type ForgeAPI interface {
	Deliver(context.Context, forgeapi.DeliverParams) (forgeapi.DeliverAck, error)
	Policy(context.Context, forgeapi.PolicyParams) (forgeapi.PolicyAck, error)
	Verify(context.Context, forgeapi.VerifyParams) (forgeapi.VerifyAck, error)
	Revoke(context.Context, forgeapi.RevokeParams) (forgeapi.RevokeAck, error)
	Status(context.Context, forgeapi.StatusParams) (forgeapi.StatusAck, error)
}

var (
	_ ForgeAPI = (*forgeapi.Service)(nil)
	_ ForgeAPI = (*forgeapi.StationInstances)(nil)
)

// NewForgeAPIHandler wraps inner with the forge.api verbs.
func NewForgeAPIHandler(inner Handler, svc ForgeAPI) Handler {
	return &forgeAPIHandler{inner: inner, svc: svc}
}

// decodeStrict decodes exactly one JSON object and rejects unknown fields and trailing data.
// The error never quotes a value, only a field name.
func decodeStrict(raw json.RawMessage, v any) error {
	if len(bytes.TrimSpace(raw)) == 0 {
		return errors.New("missing params")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("unexpected data after params")
	}
	return nil
}

func (h *forgeAPIHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	bad := func(err error) (any, bool, error) {
		return nil, false, fmt.Errorf("invalid-params: %s: %w", verb, err)
	}
	switch verb {
	case "forge.api.deliver":
		var p forgeapi.DeliverParams
		if err := decodeStrict(params, &p); err != nil {
			return bad(err)
		}
		ack, err := h.svc.Deliver(ctx, p)
		return reply(ack, err)
	case "forge.api.policy":
		var p forgeapi.PolicyParams
		if err := decodeStrict(params, &p); err != nil {
			return bad(err)
		}
		ack, err := h.svc.Policy(ctx, p)
		return reply(ack, err)
	case "forge.api.verify":
		var p forgeapi.VerifyParams
		if err := decodeStrict(params, &p); err != nil {
			return bad(err)
		}
		ack, err := h.svc.Verify(ctx, p)
		return reply(ack, err)
	case "forge.api.revoke":
		var p forgeapi.RevokeParams
		if err := decodeStrict(params, &p); err != nil {
			return bad(err)
		}
		ack, err := h.svc.Revoke(ctx, p)
		return reply(ack, err)
	case "forge.api.status":
		var p forgeapi.StatusParams
		if err := decodeStrict(params, &p); err != nil {
			return bad(err)
		}
		ack, err := h.svc.Status(ctx, p)
		return reply(ack, err)
	}
	return h.inner.Handle(ctx, verb, params, emit)
}

// reply turns a service result into a handler result. A failure is an error, never a partial
// ack: the hub must not be able to read success out of one.
func reply(ack any, err error) (any, bool, error) {
	if err != nil {
		return nil, false, err
	}
	return ack, false, nil
}

// HandleFrame forwards, as every wrapping handler must (see gitIdentityHandler).
func (h *forgeAPIHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
