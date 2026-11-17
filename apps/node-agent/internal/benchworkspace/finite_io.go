package benchworkspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"
)

// The PROPOSED finite IO profile (treaty superbench-private-execution-io). It
// selects bounded opaque transport only; it carries no scope or authority.
const FiniteVersion = "superbench.finite-io.v1"
const FiniteContentType = "application/json; profile=" + FiniteVersion
const MaxFiniteBytes = 1 << 20
const MaxFiniteBody = 2 << 20
const MaxFiniteLookup = 16 << 20

type FiniteInput struct {
	Version          string `json:"version"`
	StdinBase64      string `json:"stdin_base64"`
	StdoutLimitBytes uint64 `json:"stdout_limit_bytes"`
}

// FiniteOutput is exact sealed stdout as reported by the producer. Its bytes
// and digest are observations; they never prove fencing on their own.
type FiniteOutput struct {
	Version      string `json:"version"`
	StdoutBase64 string `json:"stdout_base64"`
	StdoutBytes  uint64 `json:"stdout_bytes"`
	StdoutSHA256 string `json:"stdout_sha256"`
}

// canonicalBase64 accepts only standard padded base64 that re-encodes to itself.
func canonicalBase64(s string) ([]byte, bool) {
	if len(s) > base64.StdEncoding.EncodedLen(MaxFiniteBytes) {
		return nil, false
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || len(raw) > MaxFiniteBytes || base64.StdEncoding.EncodeToString(raw) != s {
		return nil, false
	}
	return raw, true
}

func (i FiniteInput) Stdin() ([]byte, error) {
	if i.Version != FiniteVersion || i.StdoutLimitBytes < 1 || i.StdoutLimitBytes > MaxFiniteBytes {
		return nil, ErrInvalid
	}
	raw, ok := canonicalBase64(i.StdinBase64)
	if !ok {
		return nil, ErrInvalid
	}
	return raw, nil
}

// Stdout returns the exact decoded bytes after checking count, limit and digest.
func (o FiniteOutput) Stdout(input FiniteInput) ([]byte, error) {
	if _, err := input.Stdin(); err != nil || o.Version != FiniteVersion {
		return nil, ErrResponse
	}
	raw, ok := canonicalBase64(o.StdoutBase64)
	if !ok || uint64(len(raw)) != o.StdoutBytes || o.StdoutBytes > input.StdoutLimitBytes {
		return nil, ErrResponse
	}
	sum := sha256.Sum256(raw)
	if o.StdoutSHA256 != hex.EncodeToString(sum[:]) {
		return nil, ErrResponse
	}
	return raw, nil
}

// FiniteRunRequest is an ordinary run request plus the one final io field.
// Its canonical encoding is Go's encoding of this struct, matching the treaty
// request digest vectors.
type FiniteRunRequest struct {
	Request
	IO *FiniteInput `json:"io"`
}

func NewFiniteRun(r Request, stdin []byte, stdoutLimit uint64) (FiniteRunRequest, error) {
	f := FiniteRunRequest{Request: r, IO: &FiniteInput{Version: FiniteVersion, StdinBase64: base64.StdEncoding.EncodeToString(stdin), StdoutLimitBytes: stdoutLimit}}
	raw, err := f.Bytes()
	if err != nil {
		return FiniteRunRequest{}, err
	}
	return ParseFiniteRun(raw)
}

func (f FiniteRunRequest) Bytes() ([]byte, error) {
	if f.Operation != "run" || f.IO == nil {
		return nil, ErrInvalid
	}
	if _, err := f.IO.Stdin(); err != nil {
		return nil, err
	}
	plain, err := json.Marshal(f.Request)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, err = Parse(plain); err != nil {
		return nil, ErrInvalid
	}
	raw, err := json.Marshal(f)
	if err != nil || len(raw) > MaxFiniteBody {
		return nil, ErrInvalid
	}
	return raw, nil
}

// Digest is the producer's typed request digest, including the final io field.
func (f FiniteRunRequest) Digest() (string, error) {
	raw, err := f.Bytes()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// ParseFiniteRun accepts exactly one profiled run with exactly one valid io.
func ParseFiniteRun(raw []byte) (FiniteRunRequest, error) {
	var zero FiniteRunRequest
	if len(raw) > MaxFiniteBody || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) {
		return zero, ErrInvalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return zero, ErrInvalid
	}
	io, ok := fields["io"]
	if !ok || bytes.Equal(io, []byte("null")) {
		return zero, ErrInvalid
	}
	var input FiniteInput
	if _, ok = fieldSet(io, []string{"version", "stdin_base64", "stdout_limit_bytes"}, nil); !ok || decodeResponseObject(io, &input) != nil {
		return zero, ErrInvalid
	}
	if _, err := input.Stdin(); err != nil {
		return zero, ErrInvalid
	}
	delete(fields, "io")
	plain, err := json.Marshal(fields)
	if err != nil {
		return zero, ErrInvalid
	}
	request, err := Parse(plain)
	if err != nil || request.Operation != "run" {
		return zero, ErrInvalid
	}
	f := FiniteRunRequest{Request: request, IO: &input}
	canonical, err := json.Marshal(f)
	if err != nil || !bytes.Equal(canonical, raw) {
		return zero, ErrInvalid
	}
	return f, nil
}

// FiniteRunOutcome is a run result that may carry exact sealed stdout.
type FiniteRunOutcome struct {
	RunOutcome
	IO *FiniteOutput `json:"io,omitempty"`
}

// ParseFiniteResponse validates a profiled run response against its request.
// Success requires io; in-progress, unavailable and in-doubt replies forbid it.
func ParseFiniteResponse(raw []byte, httpStatus int, request FiniteRunRequest) (Response, error) {
	if _, err := request.Bytes(); err != nil {
		return Response{}, ErrResponse
	}
	response, err := parseResponse(raw, httpStatus, request.Request, MaxFiniteBody, true)
	if err != nil {
		return Response{}, err
	}
	outcome, _ := response.Result.(*FiniteRunOutcome)
	if response.OK && (outcome == nil || outcome.IO == nil) {
		return Response{}, ErrResponse
	}
	if outcome != nil && outcome.IO != nil {
		if response.Error != nil && oneOf(response.Error.Code, "in_progress", "unavailable", "operation_in_doubt") || outcome.Execution == nil || outcome.Execution.Phase != "stopped" || outcome.ExitCode == nil {
			return Response{}, ErrResponse
		}
		if _, err = outcome.IO.Stdout(*request.IO); err != nil {
			return Response{}, ErrResponse
		}
	}
	return response, nil
}

// FiniteTarget names the profiled run for read-only lookup or cancellation by
// its request ID and typed digest. It never resends the run.
func FiniteTarget(f FiniteRunRequest) (ReceiptLookupRequest, CancelRequest, error) {
	digest, err := f.Digest()
	if err != nil || !keyPattern.MatchString(f.RequestID) {
		return ReceiptLookupRequest{}, CancelRequest{}, ErrInvalid
	}
	return ReceiptLookupRequest{Version: Version, Operation: "receipt_lookup", TargetRequestID: f.RequestID, TargetDigest: digest},
		CancelRequest{Version: Version, Operation: "cancel", TargetRequestID: f.RequestID, TargetDigest: digest}, nil
}
