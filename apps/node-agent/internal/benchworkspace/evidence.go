package benchworkspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
)

// ExchangeEvidence retains exact private bytes for one attempted Unix exchange.
// Bytes may contain continuation capabilities; ordinary formatting and encoding
// are forbidden. Captured bytes are observations, not independent authority.
// Request capture does not prove that the service received or executed it.
// An empty response means no complete bounded JSON-media body was observed.
type ExchangeEvidence struct {
	request  []byte
	response []byte
	status   int
}

func (ExchangeEvidence) String() string               { return "[private workspace exchange]" }
func (ExchangeEvidence) GoString() string             { return "[private workspace exchange]" }
func (ExchangeEvidence) MarshalJSON() ([]byte, error) { return nil, ErrInvalid }
func (ExchangeEvidence) MarshalText() ([]byte, error) { return nil, ErrInvalid }

// Use exposes copies only to an explicit private evidence sink/verifier. Its
// error text is never returned; a failed sink does not retry the service.
func (e *ExchangeEvidence) Use(fn func(status int, request, response []byte) error) error {
	if e == nil || len(e.request) == 0 || fn == nil {
		return ErrInvalid
	}
	if fn(e.status, append([]byte(nil), e.request...), append([]byte(nil), e.response...)) != nil {
		return errors.New("private workspace exchange sink failed")
	}
	return nil
}
func evidenceDigest(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func (e *ExchangeEvidence) RequestSHA256() string {
	if e == nil || len(e.request) == 0 {
		return ""
	}
	return evidenceDigest(e.request)
}
func (e *ExchangeEvidence) ResponseSHA256() string {
	if e == nil || len(e.response) == 0 {
		return ""
	}
	return evidenceDigest(e.response)
}

// DoWithEvidence preserves Do's exact transport, validation, failure and once-only
// semantics while retaining the request bytes it attempted and response bytes it observed. Invalid or lost
// responses remain uncertain; callers must independently validate every stored
// receipt and may never infer fencing or ownership from a hash or capture alone.
func (c *Client) DoWithEvidence(ctx context.Context, request Request) (*Response, *ExchangeEvidence, error) {
	evidence := &ExchangeEvidence{}
	out, err := c.do(ctx, request, evidence)
	if len(evidence.request) == 0 {
		return out, nil, err
	}
	return out, evidence, err
}
