package benchworkspace

import (
	"encoding/json"
	"unicode/utf8"
)

const MaxReceiptLookupResponse = 512 << 10

// ReceiptLookupRequest selects existing private evidence only. The peer UID is
// kernel-authenticated; it cannot claim, execute or renew its original operation.
type ReceiptLookupRequest struct {
	Version         string `json:"version"`
	Operation       string `json:"operation"`
	TargetRequestID string `json:"target_request_id"`
	TargetDigest    string `json:"target_digest"`
}
type ReceiptLookupResult struct {
	TargetRequestID string `json:"target_request_id"`
	TargetDigest    string `json:"target_digest"`
	State           string `json:"state"`
	HTTPStatus      int    `json:"http_status,omitempty"`
	ResponseBody    string `json:"response_body,omitempty"`
}
type ReceiptLookupResponse struct {
	Version   string               `json:"version"`
	Operation string               `json:"operation"`
	OK        bool                 `json:"ok"`
	Result    *ReceiptLookupResult `json:"result,omitempty"`
	Error     *APIError            `json:"error,omitempty"`
}

func validReceiptLookupRequest(r ReceiptLookupRequest) bool {
	return r.Version == Version && r.Operation == "receipt_lookup" && keyPattern.MatchString(r.TargetRequestID) && digestPattern.MatchString(r.TargetDigest)
}
func ParseReceiptLookupRequest(raw []byte) (ReceiptLookupRequest, error) {
	var r ReceiptLookupRequest
	if !cancellationJSON(raw) {
		return r, ErrInvalid
	}
	if _, ok := fieldSet(raw, []string{"version", "operation", "target_request_id", "target_digest"}, nil); !ok {
		return r, ErrInvalid
	}
	if json.Unmarshal(raw, &r) != nil || !validReceiptLookupRequest(r) {
		return ReceiptLookupRequest{}, ErrInvalid
	}
	return r, nil
}
func NewReceiptLookupRequest(source Request) (ReceiptLookupRequest, error) {
	target, e := NewCancelRequest(source)
	if e != nil {
		return ReceiptLookupRequest{}, e
	}
	return ReceiptLookupRequest{Version: Version, Operation: "receipt_lookup", TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest}, nil
}

// ParseReceiptLookupResponse validates only historical wire evidence. A saved
// grant is not current ownership; callers must reparse the exact original body
// against their original source request and preserve all uncertainty.
func ParseReceiptLookupResponse(raw []byte, status int, target ReceiptLookupRequest) (ReceiptLookupResponse, error) {
	return parseReceiptLookup(raw, status, target, false)
}

// ParseFiniteReceiptLookupResponse is the explicitly profiled lookup: a retained
// original body up to MaxFiniteBody inside an envelope up to MaxFiniteLookup.
func ParseFiniteReceiptLookupResponse(raw []byte, status int, target ReceiptLookupRequest) (ReceiptLookupResponse, error) {
	return parseReceiptLookup(raw, status, target, true)
}
func parseReceiptLookup(raw []byte, status int, target ReceiptLookupRequest, finite bool) (ReceiptLookupResponse, error) {
	var zero ReceiptLookupResponse
	envelope, body := MaxReceiptLookupResponse, MaxBody
	if finite {
		envelope, body = MaxFiniteLookup, MaxFiniteBody
	}
	if !validReceiptLookupRequest(target) || len(raw) > envelope || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) {
		return zero, ErrResponse
	}
	fields, ok := fieldSet(raw, []string{"version", "operation", "ok"}, []string{"result", "error"})
	if !ok {
		return zero, ErrResponse
	}
	var r ReceiptLookupResponse
	if decodeResponseObject(raw, &r) != nil || r.Version != Version || r.Operation != "receipt_lookup" {
		return zero, ErrResponse
	}
	if !r.OK {
		if r.Result != nil || r.Error == nil || r.Error.Message == "" || len(r.Error.Message) > 256 || !lookupHTTPError(r.Error.Code, status) {
			return zero, ErrResponse
		}
		return r, nil
	}
	if status != 200 || r.Error != nil || r.Result == nil {
		return zero, ErrResponse
	}
	result := r.Result
	if result.TargetRequestID != target.TargetRequestID || result.TargetDigest != target.TargetDigest {
		return zero, ErrResponse
	}
	required := []string{"target_request_id", "target_digest", "state"}
	if result.State == "completed" {
		required = append(required, "http_status", "response_body")
		if result.HTTPStatus < 200 || result.HTTPStatus > 599 || result.ResponseBody == "" || len(result.ResponseBody) > body || !utf8.ValidString(result.ResponseBody) {
			return zero, ErrResponse
		}
	} else if !oneOf(result.State, "absent", "in_progress", "operation_in_doubt", "cancel_requested") {
		return zero, ErrResponse
	}
	if _, ok = fieldSet(fields["result"], required, nil); !ok {
		return zero, ErrResponse
	}
	return r, nil
}
func lookupHTTPError(code string, status int) bool {
	switch code {
	case "invalid_request":
		return status == 400 || status == 405 || status == 413 || status == 415
	case "forbidden":
		return status == 403
	case "conflict":
		return status == 409
	case "unavailable":
		return status == 503
	default:
		return false
	}
}
func ValidateReceiptLookupResponse(response ReceiptLookupResponse, status int, target ReceiptLookupRequest) error {
	raw, e := json.Marshal(response)
	if e != nil {
		return ErrResponse
	}
	_, e = ParseReceiptLookupResponse(raw, status, target)
	return e
}
