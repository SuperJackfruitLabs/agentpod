package benchworkspace

import (
	"encoding/json"
	"unicode/utf8"
)

// CancelRequest is a separate proposed extension, never an administrative stop
// or an additional ordinary growth request. The socket peer supplies identity.
type CancelRequest struct {
	Version         string `json:"version"`
	Operation       string `json:"operation"`
	TargetRequestID string `json:"target_request_id"`
	TargetDigest    string `json:"target_digest"`
}

// CancelObservation records the producer's claim only. In particular, requested
// intent and schema-valid cancelled bytes do not independently prove fencing.
type CancelObservation struct {
	TargetRequestID string `json:"target_request_id"`
	TargetDigest    string `json:"target_digest"`
	State           string `json:"state"`
}

type CancelResponse struct {
	Version   string             `json:"version"`
	Operation string             `json:"operation"`
	OK        bool               `json:"ok"`
	Result    *CancelObservation `json:"result,omitempty"`
	Error     *APIError          `json:"error,omitempty"`
}

func cancellationJSON(raw []byte) bool {
	return len(raw) <= MaxBody && utf8.Valid(raw) && scalarEscapes(raw) && strictJSON(raw)
}

func validCancelRequest(r CancelRequest) bool {
	return r.Version == Version && r.Operation == "cancel" && keyPattern.MatchString(r.TargetRequestID) && digestPattern.MatchString(r.TargetDigest)
}

func ParseCancelRequest(raw []byte) (CancelRequest, error) {
	var r CancelRequest
	if !cancellationJSON(raw) {
		return r, ErrInvalid
	}
	if _, ok := fieldSet(raw, []string{"version", "operation", "target_request_id", "target_digest"}, nil); !ok {
		return r, ErrInvalid
	}
	if json.Unmarshal(raw, &r) != nil || !validCancelRequest(r) {
		return CancelRequest{}, ErrInvalid
	}
	return r, nil
}

// NewCancelRequest derives the target from a validated original request using
// the producer's typed canonical digest. It never hashes the original wire bytes
// or supplies a lease token to a cancellation endpoint.
func NewCancelRequest(source Request) (CancelRequest, error) {
	raw, err := json.Marshal(source)
	if err != nil {
		return CancelRequest{}, ErrInvalid
	}
	parsed, err := Parse(raw)
	if err != nil || !Growth(parsed.Operation) || parsed.RequestID == "" {
		return CancelRequest{}, ErrInvalid
	}
	digest, err := parsed.Digest()
	if err != nil {
		return CancelRequest{}, ErrInvalid
	}
	return CancelRequest{Version: Version, Operation: "cancel", TargetRequestID: parsed.RequestID, TargetDigest: digest}, nil
}

// ParseCancelResponse accepts only a cap-free observation bound to both target
// echoes. Generic preparse errors belong to the opaque ordinary error envelope;
// they cannot become a trusted cancellation observation through this parser.
func ParseCancelResponse(raw []byte, status int, target CancelRequest) (CancelResponse, error) {
	var zero CancelResponse
	if !validCancelRequest(target) || !cancellationJSON(raw) {
		return zero, ErrResponse
	}
	fields, ok := fieldSet(raw, []string{"version", "operation", "ok"}, []string{"result", "error"})
	if !ok {
		return zero, ErrResponse
	}
	var r CancelResponse
	if decodeResponseObject(raw, &r) != nil || r.Version != Version || r.Operation != "cancel" || r.OK == (r.Error != nil) {
		return zero, ErrResponse
	}
	if r.OK && (status != 200 || r.Result == nil) {
		return zero, ErrResponse
	}
	if r.Error != nil && (!validHTTPError(r.Error.Code, status) || r.Error.Message == "" || len(r.Error.Message) > 256) {
		return zero, ErrResponse
	}
	if r.Result != nil {
		if _, ok := fieldSet(fields["result"], []string{"target_request_id", "target_digest", "state"}, nil); !ok {
			return zero, ErrResponse
		}
		if r.Result.TargetRequestID != target.TargetRequestID || r.Result.TargetDigest != target.TargetDigest || !oneOf(r.Result.State, "cancel_requested", "cancelled", "already_completed") {
			return zero, ErrResponse
		}
	}
	return r, nil
}
