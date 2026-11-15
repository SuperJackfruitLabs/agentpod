package benchcleanup

import (
	"errors"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// ObserveExchange is called only with the existing bench journal lock held.
// Both private plans are reconstructed by the journal, never supplied over wire.
func ObserveExchange(root string, c *benchattempt.Cancellation, supplied, current *Plan, capture *benchworkspace.ExchangeEvidence) (bool, error) {
	if c == nil || supplied == nil || current == nil || supplied.Digest() != current.Digest() || capture == nil {
		return false, benchattempt.ErrInvalid
	}
	var target benchworkspace.CancelRequest
	var lookup bool
	err := capture.Use(func(_ int, raw, _ []byte) error {
		var e error
		target, e = benchworkspace.ParseCancelRequest(raw)
		if e == nil {
			return nil
		}
		r, e := benchworkspace.ParseReceiptLookupRequest(raw)
		if e != nil {
			return benchattempt.ErrInvalid
		}
		lookup = true
		target = benchworkspace.CancelRequest{Version: r.Version, Operation: "cancel", TargetRequestID: r.TargetRequestID, TargetDigest: r.TargetDigest}
		return nil
	})
	if err != nil || !current.Accepts(benchattempt.CleanupObservation{Operation: "cancel", TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "uncertain"}) {
		return false, benchattempt.ErrInvalid
	}
	if lookup && !hasAcknowledgement(root, c, target) {
		return false, benchattempt.ErrPending
	}

	e, err := describeExchange(capture)
	if err != nil {
		return false, err
	}
	for _, old := range c.Exchanges {
		if old == e {
			_, _, err = readExchange(root, old)
			if err != nil && (!errors.Is(err, benchattempt.ErrPending) || old.ResponseSHA256 != "") {
				return false, err
			}
			return false, nil
		}
	}
	if len(c.Exchanges) >= 32 {
		return false, benchattempt.ErrInvalid
	}
	saved, err := SaveExchange(root, capture)
	if err != nil {
		return false, err
	}
	if saved != e {
		return false, benchattempt.ErrInvalid
	}

	c.Exchanges = append(c.Exchanges, e)
	return true, nil
}
func hasAcknowledgement(root string, c *benchattempt.Cancellation, t benchworkspace.CancelRequest) bool {
	found := false
	for _, e := range c.Exchanges {
		if e.Operation == "cancel" && e.TargetRequestID == t.TargetRequestID && e.TargetDigest == t.TargetDigest {
			if _, err := ReadAcknowledgement(root, e); err == nil {
				found = true
			} else if errors.Is(err, benchattempt.ErrInvalid) {
				return false
			}
		}
	}
	return found
}

// LookupTargets contains only exact original targets with independently reparsed
// successful ACKs. Missing or corrupt private files never authorize a lookup.
func LookupTargets(root string, c *benchattempt.Cancellation, p *Plan) ([]benchworkspace.ReceiptLookupRequest, error) {
	if c == nil || p == nil {
		return nil, benchattempt.ErrInvalid
	}
	var out []benchworkspace.ReceiptLookupRequest
	err := p.Use(func(targets []benchworkspace.CancelRequest, _ *benchworkspace.Request) error {
		for _, t := range targets {
			if hasAcknowledgement(root, c, t) {
				out = append(out, benchworkspace.ReceiptLookupRequest{Version: t.Version, Operation: "receipt_lookup", TargetRequestID: t.TargetRequestID, TargetDigest: t.TargetDigest})
			}
		}
		return nil
	})
	return out, err
}

// HistoricalReply independently validates a completed lookup against the exact
// original request. It never edits the source operation or converts a grant to
// fresh ownership; only the opaque exact-token cleanup plan may consume it.
func HistoricalReply(root string, c *benchattempt.Cancellation, original benchworkspace.Request) (*benchworkspace.Response, error) {
	t, err := benchworkspace.NewCancelRequest(original)
	if err != nil || c == nil {
		return nil, benchattempt.ErrInvalid
	}
	if !hasAcknowledgement(root, c, t) {
		return nil, benchattempt.ErrPending
	}
	var result *benchworkspace.Response
	var originalBody string
	var originalStatus int
	for _, e := range c.Exchanges {
		if e.Operation != "receipt_lookup" || e.TargetRequestID != t.TargetRequestID || e.TargetDigest != t.TargetDigest {
			continue
		}
		r, err := ReadLookup(root, e)
		if err != nil {
			return nil, err
		}
		if r.Result == nil || r.Result.State != "completed" {
			continue
		}
		parsed, err := benchworkspace.ParseResponse([]byte(r.Result.ResponseBody), r.Result.HTTPStatus, original)
		if err != nil {
			return nil, benchattempt.ErrInvalid
		}
		if result != nil && (originalBody != r.Result.ResponseBody || originalStatus != r.Result.HTTPStatus) {
			return nil, benchattempt.ErrConflict
		}
		originalBody, originalStatus = r.Result.ResponseBody, r.Result.HTTPStatus
		copy := parsed
		result = &copy
	}
	if result == nil {
		return nil, benchattempt.ErrPending
	}
	return result, nil
}
