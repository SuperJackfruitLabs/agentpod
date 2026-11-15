package benchworkspace

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
)

// CancelFailure never exposes remote error text. A refusal, lost reply or bad
// observation cannot prove the original operation stopped, so uncertainty stays.
type CancelFailure struct {
	Code      string
	Uncertain bool
	Response  *CancelResponse
}

func (*CancelFailure) Error() string {
	return "workspace cancellation unresolved; retain original attempt for reconciliation"
}

// Cancel is a private proposed-extension transport, sent exactly once through
// the explicit Unix client. No production dispatcher calls it before reviewed
// producer support and contract acceptance. It never falls back to v1, token/key
// stop, another host or redispatch. Success returns a producer observation only;
// requested intent does not establish fencing or authorize a handoff.
func (c *Client) Cancel(ctx context.Context, target CancelRequest) (*CancelResponse, error) {
	raw, err := json.Marshal(target)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = ParseCancelRequest(raw); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://superbench.local/v2/operations", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	fail := func(code string) (*CancelResponse, error) { return nil, &CancelFailure{Code: code, Uncertain: true} }
	reply, err := c.http.Do(req)
	if err != nil {
		return fail("transport")
	}
	defer reply.Body.Close()
	media, _, err := mime.ParseMediaType(reply.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return fail("invalid_response")
	}
	body, err := io.ReadAll(io.LimitReader(reply.Body, MaxBody+1))
	if err != nil || len(body) > MaxBody {
		return fail("invalid_response")
	}
	response, err := ParseCancelResponse(body, reply.StatusCode, target)
	if err != nil {
		return fail("invalid_response")
	}
	if !response.OK {
		return &response, &CancelFailure{Code: response.Error.Code, Uncertain: true, Response: &response}
	}
	return &response, nil
}
