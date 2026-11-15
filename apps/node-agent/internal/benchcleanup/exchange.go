package benchcleanup

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

// SaveExchange is private IO only. Its caller must own the bench journal lock
// and independently bind the returned target to a persisted cancellation plan.
// Malformed or lost responses remain evidence; capture never implies an ACK.
func describeExchange(capture *benchworkspace.ExchangeEvidence) (benchattempt.CleanupExchange, error) {
	var out benchattempt.CleanupExchange
	if capture == nil {
		return out, benchattempt.ErrInvalid
	}
	err := capture.Use(func(status int, request, response []byte) error {
		var target struct {
			Operation       string `json:"operation"`
			TargetRequestID string
			TargetDigest    string
		}
		if json.Unmarshal(request, &target) != nil {
			return benchattempt.ErrInvalid
		}
		switch target.Operation {
		case "cancel":
			r, e := benchworkspace.ParseCancelRequest(request)
			if e != nil {
				return benchattempt.ErrInvalid
			}
			target.TargetRequestID, target.TargetDigest = r.TargetRequestID, r.TargetDigest
		case "receipt_lookup":
			r, e := benchworkspace.ParseReceiptLookupRequest(request)
			if e != nil {
				return benchattempt.ErrInvalid
			}
			target.TargetRequestID, target.TargetDigest = r.TargetRequestID, r.TargetDigest
		default:
			return benchattempt.ErrInvalid
		}
		out = benchattempt.CleanupExchange{Operation: target.Operation, TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, RequestSHA256: benchattempt.RawSHA256(request), HTTPStatus: status}
		if len(response) > 0 {
			out.ResponseSHA256 = benchattempt.RawSHA256(response)
		}
		if !benchattempt.ValidCleanupExchange(out) || len(response) > benchworkspace.MaxReceiptLookupResponse {
			return benchattempt.ErrInvalid
		}

		return nil
	})
	if err != nil {
		return benchattempt.CleanupExchange{}, err
	}
	return out, nil
}

// SaveExchange writes only after the journal has checked identity and capacity.
func SaveExchange(root string, capture *benchworkspace.ExchangeEvidence) (benchattempt.CleanupExchange, error) {
	e, err := describeExchange(capture)
	if err != nil {
		return benchattempt.CleanupExchange{}, err
	}
	err = capture.Use(func(_ int, request, response []byte) error {
		if benchattempt.RawSHA256(request) != e.RequestSHA256 || (len(response) > 0 && benchattempt.RawSHA256(response) != e.ResponseSHA256) {
			return benchattempt.ErrInvalid
		}
		if err := saveExact(root, e.RequestSHA256, request); err != nil {
			return err
		}
		if len(response) > 0 {
			return saveExact(root, e.ResponseSHA256, response)
		}
		return nil
	})
	if err != nil {
		return benchattempt.CleanupExchange{}, err
	}
	return e, nil
}

func saveExact(root, hash string, raw []byte) error {
	name := "cleanup-exchange-" + hash
	old, e := benchjournal.ReadFile(filepath.Join(root, name), benchworkspace.MaxReceiptLookupResponse, true)
	if e == nil {
		if !bytes.Equal(old, raw) {
			return benchattempt.ErrConflict
		}
		return nil
	}
	if !errors.Is(e, os.ErrNotExist) {
		return benchattempt.ErrInvalid
	}
	return benchjournal.WriteAtomic(root, name, raw)
}
func readExchange(root string, e benchattempt.CleanupExchange) ([]byte, []byte, error) {
	if !benchattempt.ValidCleanupExchange(e) {
		return nil, nil, benchattempt.ErrInvalid
	}
	request, err := benchjournal.ReadFile(filepath.Join(root, "cleanup-exchange-"+e.RequestSHA256), benchworkspace.MaxBody, true)
	if err != nil || benchattempt.RawSHA256(request) != e.RequestSHA256 {
		return nil, nil, benchattempt.ErrInvalid
	}
	if e.ResponseSHA256 == "" {
		return request, nil, benchattempt.ErrPending
	}
	response, err := benchjournal.ReadFile(filepath.Join(root, "cleanup-exchange-"+e.ResponseSHA256), benchworkspace.MaxReceiptLookupResponse, true)
	if err != nil || benchattempt.RawSHA256(response) != e.ResponseSHA256 {
		return nil, nil, benchattempt.ErrInvalid
	}
	return request, response, nil
}

// ReadAcknowledgement independently reparses the immutable full target and ACK.
// It supplies lookup eligibility only; it says nothing about DB lineage or fence.
func ReadAcknowledgement(root string, e benchattempt.CleanupExchange) (benchworkspace.CancelObservation, error) {
	var zero benchworkspace.CancelObservation
	if e.Operation != "cancel" {
		return zero, benchattempt.ErrInvalid
	}
	request, response, err := readExchange(root, e)
	if err != nil {
		return zero, err
	}
	target, err := benchworkspace.ParseCancelRequest(request)
	if err != nil || target.TargetRequestID != e.TargetRequestID || target.TargetDigest != e.TargetDigest {
		return zero, benchattempt.ErrInvalid
	}
	r, err := benchworkspace.ParseCancelResponse(response, e.HTTPStatus, target)
	if err != nil || !r.OK || r.Result == nil {
		return zero, benchattempt.ErrPending
	}
	return *r.Result, nil
}

// ReadLookup returns historical private bytes only after independently validating
// both the stored request and complete lookup envelope against its original ID.
func ReadLookup(root string, e benchattempt.CleanupExchange) (benchworkspace.ReceiptLookupResponse, error) {
	var zero benchworkspace.ReceiptLookupResponse
	if e.Operation != "receipt_lookup" {
		return zero, benchattempt.ErrInvalid
	}
	request, response, err := readExchange(root, e)
	if err != nil {
		return zero, err
	}
	target, err := benchworkspace.ParseReceiptLookupRequest(request)
	if err != nil || target.TargetRequestID != e.TargetRequestID || target.TargetDigest != e.TargetDigest {
		return zero, benchattempt.ErrInvalid
	}
	r, err := benchworkspace.ParseReceiptLookupResponse(response, e.HTTPStatus, target)
	if err != nil || !r.OK {
		return zero, benchattempt.ErrPending
	}
	return r, nil
}
