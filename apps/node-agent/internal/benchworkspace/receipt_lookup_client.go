package benchworkspace

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
)

// ReceiptLookupFailure never exposes remote error text. A refusal, lost reply or bad
// observation cannot prove the original operation stopped, so uncertainty stays.
type ReceiptLookupFailure struct {
	Code      string
	Uncertain bool
	Response  *ReceiptLookupResponse
}

func (*ReceiptLookupFailure) Error() string {
	return "workspace receipt unavailable; retain original attempt for reconciliation"
}

// LookupReceipt reads historical evidence once through the explicit Unix socket.
// It never resends the original operation, claims ownership or interprets an
// absent receipt as permission to grow. Historical bodies remain private.
func (c *Client) LookupReceipt(ctx context.Context, target ReceiptLookupRequest) (*ReceiptLookupResponse, error) {
	return c.lookupReceipt(ctx, target, nil)
}

// LookupReceiptWithEvidence retains the exact private read exchange, including
// its original historical body. Captured bytes are not current ownership proof.
func (c *Client) LookupReceiptWithEvidence(ctx context.Context, target ReceiptLookupRequest) (*ReceiptLookupResponse, *ExchangeEvidence, error) {
	evidence := &ExchangeEvidence{}
	out, err := c.lookupReceipt(ctx, target, evidence)
	if len(evidence.request) == 0 {
		return out, nil, err
	}
	return out, evidence, err
}
func (c *Client) lookupReceipt(ctx context.Context, target ReceiptLookupRequest, evidence *ExchangeEvidence) (*ReceiptLookupResponse, error) {
	raw, err := json.Marshal(target)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = ParseReceiptLookupRequest(raw); err != nil {
		return nil, err
	}
	if evidence != nil {
		evidence.request = append([]byte(nil), raw...)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://superbench.local/v2/receipts/lookup", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	fail := func(code string) (*ReceiptLookupResponse, error) {
		return nil, &ReceiptLookupFailure{Code: code, Uncertain: true}
	}
	reply, err := c.http.Do(req)
	if err != nil {
		return fail("transport")
	}
	defer reply.Body.Close()
	media, _, err := mime.ParseMediaType(reply.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return fail("invalid_response")
	}
	body, err := io.ReadAll(io.LimitReader(reply.Body, MaxReceiptLookupResponse+1))
	if err != nil || len(body) > MaxReceiptLookupResponse {
		return fail("invalid_response")
	}
	if evidence != nil {
		evidence.response = append([]byte(nil), body...)
		evidence.status = reply.StatusCode
	}
	response, err := ParseReceiptLookupResponse(body, reply.StatusCode, target)
	if err != nil {
		return fail("invalid_response")
	}
	if !response.OK {
		return &response, &ReceiptLookupFailure{Code: response.Error.Code, Uncertain: true, Response: &response}
	}
	return &response, nil
}
