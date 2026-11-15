// Package benchworkspace validates the proposed grouped-workspace request contract.
// Parsing alone does not authorize execution, lease reuse, or remote access.
package benchworkspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

const Version = "superbench.v2"
const MaxBody = 64 << 10

var ErrInvalid = errors.New("invalid workspace operation request")

type Repository struct {
	Name       string `json:"name"`
	Repository string `json:"repository"`
	Branch     string `json:"branch,omitempty"`
	Base       string `json:"base,omitempty"`
}

type Source struct {
	Repository     string `json:"repository"`
	BenchID        string `json:"bench_id"`
	Commit         string `json:"commit"`
	ManifestSHA256 string `json:"manifest_sha256"`
}

type Request struct {
	Version              string       `json:"version"`
	Operation            string       `json:"operation"`
	Key                  string       `json:"key,omitempty"`
	Repositories         []Repository `json:"repositories,omitempty"`
	CheckpointRepository string       `json:"checkpoint_repository,omitempty"`
	Source               *Source      `json:"source,omitempty"`
	Holder               string       `json:"holder,omitempty"`
	RequestID            string       `json:"request_id,omitempty"`
	LeaseToken           string       `json:"lease_token,omitempty"`
	Arguments            []string     `json:"arguments,omitempty"`
	Checkpoint           *bool        `json:"checkpoint,omitempty"`
	Initialize           *bool        `json:"initialize,omitempty"`
	Offline              *bool        `json:"offline,omitempty"`
	RepositoryName       string       `json:"repository_name,omitempty"`
	QuotaBytes           *uint64      `json:"quota_bytes,omitempty"`
}

type shape struct{ required, optional []string }

var shapes = map[string]shape{
	"create":  {[]string{"key", "repositories", "checkpoint_repository", "initialize", "request_id"}, []string{"quota_bytes"}},
	"recover": {[]string{"key", "repositories", "source", "initialize", "request_id"}, []string{"quota_bytes"}},
	"status":  {nil, []string{"key"}}, "host_status": {},
	"lease":      {[]string{"key", "holder", "request_id"}, nil},
	"run":        {[]string{"key", "holder", "arguments", "request_id"}, []string{"checkpoint", "repository_name", "lease_token"}},
	"setup":      {[]string{"key", "holder", "request_id"}, []string{"offline", "repository_name", "lease_token"}},
	"checkpoint": {[]string{"key", "lease_token"}, nil}, "release": {[]string{"key", "lease_token"}, nil},
	"stop": {[]string{"key", "lease_token"}, nil}, "stop_admin": {[]string{"key"}, nil}, "archive": {[]string{"key"}, nil},
}

func Known(operation string) bool { _, ok := shapes[operation]; return ok }
func Growth(operation string) bool {
	switch operation {
	case "create", "recover", "lease", "run", "setup":
		return true
	}
	return false
}
func ReadOnly(operation string) bool { return operation == "status" || operation == "host_status" }

func Parse(raw []byte) (Request, error) {
	var zero Request
	if len(raw) > MaxBody || !utf8.Valid(raw) || !scalarEscapes(raw) || !strictJSON(raw) {
		return zero, ErrInvalid
	}
	// The shallow quota field preserves its exact numeric spelling before Go's
	// uint64 decoder can reject mathematically integral JSON such as 1024.0.
	var wire struct {
		Request
		Quota json.RawMessage `json:"quota_bytes"`
	}
	if json.Unmarshal(raw, &wire) != nil {
		return zero, ErrInvalid
	}
	r := wire.Request
	s, ok := shapes[r.Operation]
	if r.Version != Version || !ok {
		return zero, ErrInvalid
	}
	fields, ok := fieldSet(raw, append([]string{"version", "operation"}, s.required...), s.optional)
	if !ok {
		return zero, ErrInvalid
	}
	if wire.Quota != nil {
		n, ok := quota(wire.Quota)
		if !ok {
			return zero, ErrInvalid
		}
		r.QuotaBytes = &n
	}
	if !validRequest(r, fields) {
		return zero, ErrInvalid
	}
	return r, nil
}

func quota(raw []byte) (uint64, bool) {
	// Normalize decimal spelling exactly, without floating-point rounding or
	// allocating powers for hostile exponents. The transport already bounds text.
	mantissa := string(raw)
	var exponent int64
	if i := strings.IndexAny(mantissa, "eE"); i >= 0 {
		var err error
		exponent, err = strconv.ParseInt(mantissa[i+1:], 10, 64)
		if err != nil || exponent < -MaxBody || exponent > MaxBody {
			return 0, false
		}
		mantissa = mantissa[:i]
	}
	if i := strings.IndexByte(mantissa, '.'); i >= 0 {
		exponent -= int64(len(mantissa) - i - 1)
		mantissa = mantissa[:i] + mantissa[i+1:]
	}
	mantissa = strings.TrimLeft(mantissa, "0")
	trimmed := strings.TrimRight(mantissa, "0")
	exponent += int64(len(mantissa) - len(trimmed))
	if trimmed == "" || exponent < 0 || int64(len(trimmed))+exponent > 16 {
		return 0, false
	}
	value, err := strconv.ParseUint(trimmed+strings.Repeat("0", int(exponent)), 10, 64)
	if err != nil {
		return 0, false
	}
	return value, value >= 1024 && value <= 1<<50 && value%1024 == 0
}

func (r Request) Digest() (string, error) {
	raw, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
