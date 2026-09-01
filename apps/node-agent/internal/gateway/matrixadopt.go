package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
)

// MatrixCredential is what the hub hands back when a node redeems a live
// authorization for a station's new Matrix identity.
//
// SECURITY: AccessToken is the one field here that must never be logged,
// folded into an error string, or otherwise made to outlive the profile
// write it exists for. See ProfileWriteFunc's caller in matrixAdoptHandler.
type MatrixCredential struct {
	UserID      string `json:"userId"`
	AccessToken string `json:"accessToken"`
	DeviceID    string `json:"deviceId"`
}

// CredentialFetcher redeems this node's authority to fetch key's new Matrix
// credential from the hub.
//
// A refusal — no live authorization for the station, or one already spent —
// is the hub's ordinary 403 for this endpoint, and comes back here as a
// plain error like any other fetch failure. matrixAdoptHandler does not
// distinguish it from a network error or a 5xx: either way there is no
// credential to write, so it refuses the same way. See station-matrix-
// credential.ts for why this is the endpoint's normal shape, not a fault.
type CredentialFetcher func(ctx context.Context, key string) (MatrixCredential, error)

// NewHTTPCredentialFetcher returns the production CredentialFetcher: it POSTs
// to the hub's redemption endpoint, authenticated with this node's own
// long-term credential — the same `Bearer <nodeId>:<nodeSecret>` scheme
// gateway.Run already dials the websocket with.
//
// hub, nodeID and nodeSecret are captured at construction so the returned
// func needs nothing but a station key at call time, the same shape
// LifecycleFunc and WorkspaceFunc already take.
func NewHTTPCredentialFetcher(hub, nodeID, nodeSecret string) CredentialFetcher {
	base := strings.TrimSuffix(hub, "/")
	return func(ctx context.Context, key string) (MatrixCredential, error) {
		u := base + "/api/nodes/" + url.PathEscape(nodeID) + "/stations/" + url.PathEscape(key) + "/matrix-credential"
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
		if err != nil {
			return MatrixCredential{}, fmt.Errorf("matrix.adopt: building request: %w", err)
		}
		req.Header.Set("Authorization", "Bearer "+nodeID+":"+nodeSecret)

		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return MatrixCredential{}, fmt.Errorf("matrix.adopt: could not reach the hub: %w", err)
		}
		defer res.Body.Close()

		if res.StatusCode != http.StatusOK {
			// Drain and discard rather than read the body into an error: a
			// refusal body carries no credential today, but this is the
			// security boundary for that fact, not a case-by-case judgement.
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4<<10))
			return MatrixCredential{}, fmt.Errorf("matrix.adopt: hub refused the redemption (status %d)", res.StatusCode)
		}

		var cred MatrixCredential
		if err := json.NewDecoder(res.Body).Decode(&cred); err != nil {
			return MatrixCredential{}, fmt.Errorf("matrix.adopt: decoding hub response: %w", err)
		}
		return cred, nil
	}
}

// ProfileWriteFunc installs mxid and accessToken as a harness's Matrix
// credential in the profile at profileDir. It is descriptor.ProfileWriter's
// Write method, resolved by the caller — this package stays free of a direct
// descriptor import, the same separation LifecycleFunc and ACPCommandFunc
// already keep.
type ProfileWriteFunc func(profileDir, mxid, accessToken string) error

// WriterLookupFunc resolves whether harness has a registered Matrix profile
// writer, returning the ProfileWriteFunc to call if so. Backed by
// descriptor.WriterFor in production; tests inject their own so they can
// exercise unsupported harnesses without touching package-level registry
// state.
type WriterLookupFunc func(harness string) (write ProfileWriteFunc, ok bool)

// matrixAdoptHandler wraps an inner Handler and adds the matrix.adopt verb:
// fetch this station's new Matrix credential from the hub, write it into the
// harness's profile, then restart the harness so it picks the identity up.
//
// Order is the entire point of this file: write, THEN restart. A restart
// before the write reloads the OLD identity — the harness comes back up
// reporting the mxid it always had, which reads to the hub as "this station
// has not converged" rather than as any kind of error. Nothing in any log
// says so; the move just silently never finishes.
type matrixAdoptHandler struct {
	inner      Handler
	resolver   WorkspaceResolver // profile dir == workspace dir for every writer this slice ships
	harnessFor func(key string) (string, error)
	writerFor  WriterLookupFunc
	fetch      CredentialFetcher
	restart    func(key string) error
}

// NewMatrixAdoptHandler wraps inner with the matrix.adopt verb.
//
//   - resolver resolves a station key to its profile directory — the same
//     WorkspaceResolver term.open and changeset.* already use. For every
//     harness this slice's writers cover, the profile a writer targets IS
//     the station's workspace.
//   - harnessFor resolves a station key to its harness name, so the right
//     writer can be looked up before anything reaches the network.
//   - writerFor resolves the ProfileWriteFunc for a harness; see
//     WriterLookupFunc.
//   - fetch redeems this node's authority for key's new credential over
//     HTTP; see NewHTTPCredentialFetcher for the production implementation.
//   - restart performs the "restart" lifecycle action for key — reused from
//     the existing lifecycle verb path, not reimplemented; see
//     cmd/agentpod-node/run.go's lifecycleFn.
func NewMatrixAdoptHandler(
	inner Handler,
	resolver WorkspaceResolver,
	harnessFor func(key string) (string, error),
	writerFor WriterLookupFunc,
	fetch CredentialFetcher,
	restart func(key string) error,
) Handler {
	return &matrixAdoptHandler{
		inner:      inner,
		resolver:   resolver,
		harnessFor: harnessFor,
		writerFor:  writerFor,
		fetch:      fetch,
		restart:    restart,
	}
}

// Handle intercepts "matrix.adopt" and delegates every other verb to inner.
func (h *matrixAdoptHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "matrix.adopt" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	var p struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Key == "" {
		return nil, false, fmt.Errorf("matrix.adopt: bad params: missing key")
	}

	harness, err := h.harnessFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: %w", p.Key, err)
	}

	// Refuse before any HTTP call: fetching a credential this node has no
	// way to store would spend a live, single-use authorization for
	// nothing — the human would have to re-authorise the move from scratch
	// for a station that was never going to converge.
	write, ok := h.writerFor(harness)
	if !ok {
		return nil, false, fmt.Errorf("matrix.adopt: %q: harness %q has no Matrix profile writer", p.Key, harness)
	}

	profileDir, err := h.resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: profile dir: %w", p.Key, err)
	}

	cred, err := h.fetch(ctx, p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: %w", p.Key, err)
	}

	if err := write(profileDir, cred.UserID, cred.AccessToken); err != nil {
		// The write failed: there is nothing to restart into, and restarting
		// anyway would tear the station down without ever handing it the
		// identity it was supposed to come back up with.
		return nil, false, fmt.Errorf("matrix.adopt: %q: writing profile: %w", p.Key, err)
	}

	if err := h.restart(p.Key); err != nil {
		// The credential IS written at this point — the profile now names
		// the new identity even though the running process has not picked
		// it up yet. Said plainly so an operator does not read this as "the
		// move never happened".
		return nil, false, fmt.Errorf("matrix.adopt: %q: wrote the credential but could not restart: %w", p.Key, err)
	}

	log.Printf("gateway: matrix.adopt converged station %q to %s", p.Key, cred.UserID)

	return map[string]any{"accepted": true}, false, nil
}

// HandleFrame forwards inbound terminal/ACP input frames to the inner
// handler when it implements FrameHandler — mirrors updateHandler and
// acpHandler, which wrap the same chain. Without this, inserting
// matrixAdoptHandler anywhere above a FrameHandler would silently drop every
// keystroke reaching it.
func (h *matrixAdoptHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}
