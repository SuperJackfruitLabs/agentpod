package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"time"
)

// MatrixLogin is a harness-mode profile's Matrix login.
//
// SECURITY: AccessToken must never be logged, folded into an error string, or
// returned in a verb result.
type MatrixLogin struct {
	Homeserver  string
	UserID      string
	AccessToken string
}

// MatrixAvatarDeps is everything the matrix.avatar.set verb needs.
type MatrixAvatarDeps struct {
	// HarnessFor resolves a station key to its harness name.
	HarnessFor func(key string) (string, error)
	// Resolver resolves a station key to its profile directory.
	Resolver WorkspaceResolver
	// ReadFile reads a workspace-relative file through the station's own
	// descriptor, so the same path confinement fs.read has applies here.
	ReadFile func(key, path string, maxBytes int64) (content []byte, truncated bool, err error)
	// Login reads the profile's Matrix login; descriptor.MatrixCredentialsFromEnv.
	Login func(profileDir string) (MatrixLogin, error)
	// HTTP is the client used to reach the homeserver. nil means a default
	// with a timeout.
	HTTP *http.Client
}

// matrixAvatarHarnesses are the harnesses whose Matrix login this node knows
// how to find. Hermes only, for the same reason transcriptionHarnesses is.
var matrixAvatarHarnesses = map[string]bool{"hermes": true}

// matrixAvatarMaxBytes is the largest image this verb uploads. Hermes' own
// pfp.png files run to about 2 MB; homeservers commonly cap uploads at 50 MB,
// but an avatar is thumbnailed to 256px, so anything near this is waste.
const matrixAvatarMaxBytes = 8 << 20

// matrixAvatarTypes are the sniffed content types an avatar may have.
var matrixAvatarTypes = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
}

// matrixAvatarResult is VERB_RESULTS["matrix.avatar.set"] in the contract.
type matrixAvatarResult struct {
	MatrixID string `json:"matrixId"`
	MXC      string `json:"mxc"`
}

// matrixAvatarHandler wraps an inner Handler and adds matrix.avatar.set: make
// an image in the station's workspace its Matrix profile picture.
//
// A harness-mode station holds its own Matrix account, outside the hub's
// appservice namespace, so the hub cannot set its avatar (403). The node can:
// the profile's .env carries the login. The token is used here, against the
// homeserver, and goes nowhere else — not to the hub, not into a result.
type matrixAvatarHandler struct {
	inner Handler
	deps  MatrixAvatarDeps
}

// NewMatrixAvatarHandler wraps inner with the matrix.avatar.set verb.
func NewMatrixAvatarHandler(inner Handler, deps MatrixAvatarDeps) Handler {
	if deps.HTTP == nil {
		deps.HTTP = &http.Client{Timeout: 30 * time.Second}
	}
	return &matrixAvatarHandler{inner: inner, deps: deps}
}

// HandleFrame forwards terminal and ACP input frames; see changesetHandler.
func (h *matrixAvatarHandler) HandleFrame(frameType, id string, raw json.RawMessage) error {
	if fh, ok := h.inner.(FrameHandler); ok {
		return fh.HandleFrame(frameType, id, raw)
	}
	return nil
}

// Handle intercepts "matrix.avatar.set" and delegates every other verb.
func (h *matrixAvatarHandler) Handle(
	ctx context.Context,
	verb string,
	params json.RawMessage,
	emit func(seq int, chunk string, eof bool, enc string) error,
) (any, bool, error) {
	if verb != "matrix.avatar.set" {
		return h.inner.Handle(ctx, verb, params, emit)
	}

	var p struct {
		Key  string `json:"key"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(params, &p); err != nil || p.Key == "" || p.Path == "" {
		return nil, false, fmt.Errorf("matrix.avatar.set: bad params: missing key or path")
	}

	harness, err := h.deps.HarnessFor(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q: %w", p.Key, err)
	}
	if !matrixAvatarHarnesses[harness] {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q: harness %q has no Matrix login this node can use (only hermes is supported)", p.Key, harness)
	}

	content, truncated, err := h.deps.ReadFile(p.Key, p.Path, matrixAvatarMaxBytes)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.avatar.set: reading %q: %w", p.Path, err)
	}
	if truncated {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q is larger than %d MB", p.Path, matrixAvatarMaxBytes>>20)
	}
	// Sniffed, not taken from the extension: this verb authenticates as the
	// agent, and a mislabelled text file is exactly what must not be uploaded
	// under its name.
	contentType := http.DetectContentType(content)
	if !matrixAvatarTypes[contentType] {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q is not an image (%s); use a PNG, JPEG, GIF or WebP", p.Path, contentType)
	}

	profileDir, err := h.deps.Resolver.Workspace(p.Key)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q: profile dir: %w", p.Key, err)
	}
	login, err := h.deps.Login(profileDir)
	if err != nil {
		return nil, false, fmt.Errorf("matrix.avatar.set: %q: %w", p.Key, err)
	}

	mxc, err := h.upload(ctx, login, path.Base(p.Path), contentType, content)
	if err != nil {
		return nil, false, err
	}
	if err := h.setAvatar(ctx, login, mxc); err != nil {
		return nil, false, err
	}
	return matrixAvatarResult{MatrixID: login.UserID, MXC: mxc}, false, nil
}

func (h *matrixAvatarHandler) upload(ctx context.Context, login MatrixLogin, filename, contentType string, content []byte) (string, error) {
	u := login.Homeserver + "/_matrix/media/v3/upload?filename=" + url.QueryEscape(filename)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(content))
	if err != nil {
		return "", fmt.Errorf("matrix.avatar.set: building upload: %w", err)
	}
	req.Header.Set("Content-Type", contentType)
	var body struct {
		ContentURI string `json:"content_uri"`
	}
	if err := h.do(req, login, "upload", &body); err != nil {
		return "", err
	}
	if body.ContentURI == "" {
		return "", fmt.Errorf("matrix.avatar.set: the homeserver accepted the upload but returned no content_uri")
	}
	return body.ContentURI, nil
}

func (h *matrixAvatarHandler) setAvatar(ctx context.Context, login MatrixLogin, mxc string) error {
	u := login.Homeserver + "/_matrix/client/v3/profile/" + url.PathEscape(login.UserID) + "/avatar_url"
	payload, _ := json.Marshal(map[string]string{"avatar_url": mxc})
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("matrix.avatar.set: building profile update: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	return h.do(req, login, "profile update", nil)
}

// do sends req as the harness. Errors name the step, the status and the
// homeserver's errcode — never the token, and never the raw body.
func (h *matrixAvatarHandler) do(req *http.Request, login MatrixLogin, step string, out any) error {
	req.Header.Set("Authorization", "Bearer "+login.AccessToken)
	// Cloudflare in front of the fleet's homeserver refuses some default
	// client user agents outright (error 1010).
	req.Header.Set("User-Agent", "agentpod-node")
	res, err := h.deps.HTTP.Do(req)
	if err != nil {
		// url.Error quotes the URL, which carries no credential.
		return fmt.Errorf("matrix.avatar.set: %s: could not reach the homeserver: %w", step, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Errcode string `json:"errcode"`
		}
		_ = json.Unmarshal(raw, &e)
		if e.Errcode == "" {
			e.Errcode = "no errcode"
		}
		return fmt.Errorf("matrix.avatar.set: %s: homeserver answered %d (%s)", step, res.StatusCode, e.Errcode)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("matrix.avatar.set: %s: the homeserver's answer did not decode", step)
		}
	}
	return nil
}
