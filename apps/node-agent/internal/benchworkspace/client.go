package benchworkspace

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"path/filepath"
	"time"
)

// Failure excludes remote messages, request bodies and capabilities from Error.
// A retained response is private historical evidence, not renewed ownership.
type Failure struct {
	Code      string
	Uncertain bool
	Response  *Response
}

func (f *Failure) Error() string {
	if f.Uncertain {
		return "workspace source outcome uncertain; retain attempt for reconciliation"
	}
	return "workspace source operation refused: " + f.Code
}

type Client struct{ http *http.Client }

// NewClient selects only an explicit host-local Unix socket. The proposed v2
// contract must be accepted and discovered before any production caller uses it.
func NewClient(socket string, timeout time.Duration) (*Client, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket || timeout <= 0 || timeout > time.Hour {
		return nil, errors.New("canonical absolute socket and timeout in (0,1h] required")
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
		DisableCompression:     true,
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 64 << 10,
	}
	return &Client{http: &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Close() { c.http.CloseIdleConnections() }

// Do sends once, without discovery guesses, protocol fallback, administrative
// stop, acquisition or child redispatch. Every failed mutation still belongs to
// its durable attempt, regardless of the failure's uncertainty classification.
func (c *Client) Do(ctx context.Context, request Request) (*Response, error) {
	return c.do(ctx, request, nil)
}

func (c *Client) do(ctx context.Context, request Request, evidence *ExchangeEvidence) (*Response, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err = Parse(raw); err != nil {
		return nil, err
	}
	if evidence != nil {
		evidence.request = append([]byte(nil), raw...)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://superbench.local/v2/operations", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	failed := func(code string) (*Response, error) {
		return nil, &Failure{Code: code, Uncertain: !ReadOnly(request.Operation)}
	}
	reply, err := c.http.Do(req)
	if err != nil {
		return failed("transport")
	}
	defer reply.Body.Close()
	media, _, err := mime.ParseMediaType(reply.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return failed("invalid_response")
	}
	limit := MaxResponse
	if Growth(request.Operation) {
		limit = MaxBody
	}
	body, err := io.ReadAll(io.LimitReader(reply.Body, int64(limit)+1))
	if err != nil || len(body) > limit {
		return failed("invalid_response")
	}
	if evidence != nil {
		evidence.response = append([]byte(nil), body...)
		evidence.status = reply.StatusCode
	}
	parsed, err := ParseResponse(body, reply.StatusCode, request)
	if err != nil {
		return failed("invalid_response")
	}
	if !parsed.OK {
		code := parsed.Error.Code
		uncertain := !ReadOnly(request.Operation) && (code == "in_progress" || code == "operation_in_doubt" || code == "unavailable")
		return &parsed, &Failure{Code: code, Uncertain: uncertain, Response: &parsed}
	}
	return &parsed, nil
}
