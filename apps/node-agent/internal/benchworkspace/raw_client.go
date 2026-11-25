package benchworkspace

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
)

// ErrLost means no complete bounded JSON reply was observed. The request may
// or may not have reached the producer; callers keep their attempt uncertain.
var ErrLost = errors.New("workspace reply lost; retain attempt for reconciliation")

// Fixed endpoints. Post never selects another path, protocol or host.
const (
	PathOperations   = "/v2/operations"
	PathReceipts     = "/v2/receipts/lookup"
	PathRegistration = "/v2/registrations/observe"
)

// Post sends exact caller-validated bytes once and returns the status and the
// complete bounded body. It never retries, follows redirects or parses results.
func (c *Client) Post(ctx context.Context, path, contentType string, raw []byte, limit int) (int, []byte, error) {
	switch path {
	case PathOperations, PathReceipts, PathRegistration, PathRemoteCredentials, PathRemoteStatus:
	default:
		return 0, nil, ErrInvalid
	}
	if contentType != "application/json" && contentType != FiniteContentType || limit < 1 || limit > MaxFiniteLookup {
		return 0, nil, ErrInvalid
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://superbench.local"+path, bytes.NewReader(raw))
	if err != nil {
		return 0, nil, ErrInvalid
	}
	req.Header.Set("Content-Type", contentType)
	reply, err := c.http.Do(req)
	if err != nil {
		return 0, nil, ErrLost
	}
	defer reply.Body.Close()
	media, _, err := mime.ParseMediaType(reply.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return 0, nil, ErrLost
	}
	body, err := io.ReadAll(io.LimitReader(reply.Body, int64(limit)+1))
	if err != nil || len(body) > limit {
		return 0, nil, ErrLost
	}
	return reply.StatusCode, body, nil
}
