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

// CredentialFetcher redeems this node's authority to fetch a station's new
// Matrix credential from the hub. stationId is the station's DATABASE id —
// what the hub's redemption endpoint is keyed by — not the station key.
//
// A refusal — no live authorization for the station, or one already spent —
// is the hub's ordinary 403 for this endpoint, and comes back here as a
// plain error like any other fetch failure. matrixAdoptHandler does not
// distinguish it from a network error or a 5xx: either way there is no
// credential to write, so it refuses the same way. See station-matrix-
// credential.ts for why this is the endpoint's normal shape, not a fault.
type CredentialFetcher func(ctx context.Context, stationId string) (MatrixCredential, error)

// NewHTTPCredentialFetcher returns the production CredentialFetcher: it POSTs
// to the hub's redemption endpoint, authenticated with this node's own
// long-term credential — the same `Bearer <nodeId>:<nodeSecret>` scheme
// gateway.Run already dials the websocket with.
//
// hub, nodeID and nodeSecret are captured at construction so the returned
// func needs nothing but a station's database id at call time, the same
// shape LifecycleFunc and WorkspaceFunc already take (there, keyed by
// station key — here, by database id, because that's what the hub's URL
// needs).
func NewHTTPCredentialFetcher(hub, nodeID, nodeSecret string) CredentialFetcher {
	base := strings.TrimSuffix(hub, "/")
	return func(ctx context.Context, stationId string) (MatrixCredential, error) {
		u := base + "/api/nodes/" + url.PathEscape(nodeID) + "/stations/" + url.PathEscape(stationId) + "/matrix-credential"
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

// CapabilityLookupFunc resolves the capability list a station key currently
// advertises — the same list `detect` reports to the hub. Backed in
// production by the descriptor registry; see MatrixAdoptDeps.CapabilitiesFor
// for what this handler does with it.
type CapabilityLookupFunc func(key string) ([]string, error)

// MatrixIDReadFunc reads back the Matrix identity a profile now names,
// returning nil when it names none. It is descriptor.MatrixIDFromProfile,
// resolved by the caller — the same separation ProfileWriteFunc keeps.
//
// This is the READER, not a second copy of what was written, and the
// difference is the point: a writer that put the credential in a file the
// harness never loads is invisible to anything that reports back what it
// meant to write, and visible immediately to this. Design §3 calls that
// failure "the outage reproduced with a green signal in front of it".
type MatrixIDReadFunc func(profileDir string) *string

// matrixAdoptHandler wraps an inner Handler and adds the matrix.adopt verb:
// fetch this station's new Matrix credential from the hub, write it into the
// harness's profile, restart the harness so it picks the identity up, and
// report back the identity the profile now reads as.
//
// Order is the entire point of this file: write, THEN restart. A restart
// before the write reloads the OLD identity — the harness comes back up
// reporting the mxid it always had, which reads to the hub as "this station
// has not converged" rather than as any kind of error. Nothing in any log
// says so; the move just silently never finishes.
//
// **And the read-back is what closes the move at all.** Design §4 step 5 said
// the node reports the new mxid "on its next detect", and there is no next
// detect: this verb restarts the HARNESS, not the node-agent, so the
// websocket whose open triggers a capability refresh never reopens. Without
// the value returned here the hub never sees convergence, never retires the
// old identity, and leaves its credential live forever.
type matrixAdoptHandler struct {
	inner Handler
	deps  MatrixAdoptDeps
}

// MatrixAdoptDeps is everything the matrix.adopt verb needs, named rather
// than positional: seven collaborators in a fixed order is a call site where
// two same-typed funcs can be swapped silently.
type MatrixAdoptDeps struct {
	// Resolver resolves a station key to its profile directory — the same
	// WorkspaceResolver term.open and changeset.* already use. For every
	// harness this slice's writers cover, the profile a writer targets IS the
	// station's workspace.
	Resolver WorkspaceResolver

	// HarnessFor resolves a station key to its harness name, so the right
	// writer can be looked up before anything reaches the network.
	HarnessFor func(key string) (string, error)

	// CapabilitiesFor resolves what a station key can actually be asked to do.
	//
	// This verb ends in a restart, and `lifecycle` is exactly the capability
	// that says a station may be restarted. A Hermes profile that shares the
	// root gateway's Matrix identity has it deliberately withheld
	// (descriptor/hermes.go, issue #273): that profile is a VIEW onto the
	// agent the root gateway already runs, not a separately startable thing,
	// and starting it would put a second gateway on one messaging identity.
	// Such a station still has matrix_id != bridge_matrix_id, so the console
	// offers it the move — which is why the refusal has to live here, on the
	// side that knows what the station is.
	CapabilitiesFor CapabilityLookupFunc

	// WriterFor resolves the ProfileWriteFunc for a harness; see
	// WriterLookupFunc.
	WriterFor WriterLookupFunc

	// Fetch redeems this node's authority for the station's new credential
	// over HTTP; see NewHTTPCredentialFetcher for the production
	// implementation.
	Fetch CredentialFetcher

	// Restart performs the "restart" lifecycle action for key — reused from
	// the existing lifecycle verb path, not reimplemented; see
	// cmd/agentpod-node/run.go's lifecycleFn.
	Restart func(key string) error

	// ReadIdentity reads the profile back through the real reader; see
	// MatrixIDReadFunc.
	ReadIdentity MatrixIDReadFunc
}

// NewMatrixAdoptHandler wraps inner with the matrix.adopt verb.
func NewMatrixAdoptHandler(inner Handler, deps MatrixAdoptDeps) Handler {
	return &matrixAdoptHandler{inner: inner, deps: deps}
}

// hasCapability reports whether caps contains want.
func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
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

	// key is the station key (e.g. "hermes:writer-quill") — what harnessFor
	// and resolver.Workspace use, exactly as every other verb in this
	// package does. stationId is the station's DATABASE id — what the hub's
	// redemption endpoint is keyed by. Neither can stand in for the other
	// (Defect 2 of task-6b): a URL built from the key is a URL the hub
	// cannot resolve.
	var p struct {
		Key       string `json:"key"`
		StationID string `json:"stationId"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Key == "" || p.StationID == "" {
		return nil, false, fmt.Errorf("matrix.adopt: bad params: missing key or stationId")
	}

	harness, err := h.deps.HarnessFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: %w", p.Key, err)
	}

	// Refuse before any HTTP call: fetching a credential this node has no
	// way to store would spend a live, single-use authorization for
	// nothing — the human would have to re-authorise the move from scratch
	// for a station that was never going to converge.
	write, ok := h.deps.WriterFor(harness)
	if !ok {
		return nil, false, fmt.Errorf("matrix.adopt: %q: harness %q has no Matrix profile writer", p.Key, harness)
	}

	// The same posture, one refusal over: a station this node may not restart
	// cannot complete a move, because the restart is how the harness picks the
	// new credential up. Refusing here — before the fetch — leaves the
	// authorization unspent and the station exactly as it was, rather than
	// writing a credential into a profile whose process nothing may cycle.
	//
	// Restarting anyway is the worse half: `lifecycle` is withheld from a
	// Hermes profile sharing the root gateway's identity precisely so nothing
	// starts a second gateway on that identity (issue #273), and this verb
	// would have done it through a path that never asked.
	caps, err := h.deps.CapabilitiesFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: capabilities: %w", p.Key, err)
	}
	if !hasCapability(caps, "lifecycle") {
		return nil, false, fmt.Errorf(
			"matrix.adopt: %q: this station has no \"lifecycle\" capability, so its harness "+
				"cannot be restarted to pick up a new identity — a Hermes profile sharing the "+
				"root gateway's Matrix identity is a view onto that agent rather than a "+
				"separately startable one (issue #273), and the root station is where it moves",
			p.Key,
		)
	}

	profileDir, err := h.deps.Resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: profile dir: %w", p.Key, err)
	}

	cred, err := h.deps.Fetch(ctx, p.StationID)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.adopt: %q: %w", p.Key, err)
	}

	if err := write(profileDir, cred.UserID, cred.AccessToken); err != nil {
		// The write failed: there is nothing to restart into, and restarting
		// anyway would tear the station down without ever handing it the
		// identity it was supposed to come back up with.
		return nil, false, fmt.Errorf("matrix.adopt: %q: writing profile: %w", p.Key, err)
	}

	if err := h.deps.Restart(p.Key); err != nil {
		// The credential IS written at this point — the profile now names
		// the new identity even though the running process has not picked
		// it up yet. Said plainly so an operator does not read this as "the
		// move never happened".
		return nil, false, fmt.Errorf("matrix.adopt: %q: wrote the credential but could not restart: %w", p.Key, err)
	}

	// The move's only trigger, and the write's only real verification: read
	// the profile back through the reader a detect would have used. A writer
	// that put the credential where the harness does not look reports nil (or
	// the OLD mxid) here, which the hub reads as "not converged" — the safe
	// state §4 promises — instead of the green signal echoing cred.UserID
	// back would have produced.
	var reported any
	if mxid := h.deps.ReadIdentity(profileDir); mxid != nil {
		reported = *mxid
		log.Printf("gateway: matrix.adopt restarted station %q, profile now reads as %s", p.Key, *mxid)
	} else {
		// Not an error: the credential is written and the harness restarted,
		// so the station is no worse off than before. But the hub will not
		// see convergence, so say why here rather than let it be silent.
		log.Printf(
			"gateway: matrix.adopt wrote and restarted station %q but its profile reads as no "+
				"Matrix identity — the hub will not see this move converge",
			p.Key,
		)
	}

	return map[string]any{"accepted": true, "matrixId": reported}, false, nil
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
