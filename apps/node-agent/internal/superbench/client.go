package superbench

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"time"
	"unicode/utf8"
)

type Execution struct {
	ID       string `json:"id"`
	Phase    string `json:"phase"`
	LogPath  string `json:"log_path"`
	LogLimit uint64 `json:"log_limit_bytes"`
}
type Lease struct {
	Mode      string     `json:"mode"`
	Holder    string     `json:"holder"`
	Token     string     `json:"token,omitempty"`
	Execution *Execution `json:"execution,omitempty"`
}
type Bench struct {
	Key         string `json:"key"`
	Repository  string `json:"repository"`
	Branch      string `json:"branch"`
	Path        string `json:"path"`
	Checkpoint  string `json:"checkpoint"`
	Lease       *Lease `json:"lease,omitempty"`
	ArchivedAt  string `json:"archived_at,omitempty"`
	Reaping     bool   `json:"reaping,omitempty"`
	ReapedAt    string `json:"reaped_at,omitempty"`
	ProjectID   uint32 `json:"project_id"`
	QuotaInodes uint64 `json:"quota_inodes"`
	QuotaBytes  uint64 `json:"quota_bytes"`
}
type Result struct {
	Bench          *Bench     `json:"bench,omitempty"`
	Benches        []Bench    `json:"benches,omitempty"`
	Execution      *Execution `json:"execution,omitempty"`
	ExitCode       *int       `json:"exit_code,omitempty"`
	LogTruncated   bool       `json:"log_truncated,omitempty"`
	Released       string     `json:"released,omitempty"`
	Managed        bool       `json:"managed,omitempty"`
	DataFreeBytes  uint64     `json:"data_free_bytes,omitempty"`
	StateFreeBytes uint64     `json:"state_free_bytes,omitempty"`
}
type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Response struct {
	Version   string    `json:"version"`
	Operation string    `json:"operation,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
	OK        bool      `json:"ok"`
	Result    *Result   `json:"result,omitempty"`
	Error     *APIError `json:"error,omitempty"`
}

// Failure deliberately excludes response text, tokens and command output from Error.
// Response may retain the exact submitted operation's capability. Neither uncertainty
// nor a historic receipt grants permission to rerun a child or acquire another lease.
type Failure struct {
	Code      string
	Uncertain bool
	Response  *Response
}

func (f *Failure) Error() string {
	if f.Uncertain {
		return "superbench outcome uncertain; inspect ownership before reconciliation"
	}
	return "superbench operation refused: " + f.Code
}

type Client struct{ http *http.Client }

func NewClient(socket string, timeout time.Duration) (*Client, error) {
	if !filepath.IsAbs(socket) || filepath.Clean(socket) != socket || timeout <= 0 {
		return nil, errors.New("absolute socket and positive timeout required")
	}
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	return &Client{http: &http.Client{Transport: transport, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}
func (c *Client) Close() { c.http.CloseIdleConnections() }

// Do performs exactly one request. There is intentionally no transport retry,
// automatic stop_admin, redispatch, or fallback to generic ACP/another API version.
func (c *Client) Do(ctx context.Context, request Request) (*Response, error) {
	raw, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err = Parse(raw); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://superbench.local/v1/operations", bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	reply, err := c.http.Do(req)
	if err != nil {
		return nil, &Failure{Code: "transport", Uncertain: !ReadOnly(request.Operation)}
	}
	defer reply.Body.Close()
	raw, err = io.ReadAll(io.LimitReader(reply.Body, MaxResponse+1))
	if err != nil || len(raw) > MaxResponse {
		return nil, &Failure{Code: "invalid_response", Uncertain: !ReadOnly(request.Operation)}
	}
	var out Response
	if strictJSON(raw, &out) != nil || !responseRequired(raw) || out.Version != Version || out.Operation != request.Operation || (Growth(request.Operation) && out.RequestID != request.RequestID) || (!Growth(request.Operation) && out.RequestID != "") || out.OK != (reply.StatusCode >= 200 && reply.StatusCode < 300) || (out.OK && (out.Result == nil || out.Error != nil)) || (!out.OK && (out.Error == nil || out.Error.Code == "")) {
		return nil, &Failure{Code: "invalid_response", Uncertain: !ReadOnly(request.Operation)}
	}
	if out.Result != nil && !resultShape(raw, request.Operation, out.OK) {
		return nil, &Failure{Code: "invalid_result", Uncertain: !ReadOnly(request.Operation)}
	}
	if !out.OK {
		if ReadOnly(request.Operation) && out.Result != nil && validateResult(request, out.Result) != nil {
			return nil, &Failure{Code: "invalid_result"}
		}
		switch out.Error.Code {
		case "invalid_request", "forbidden", "not_found", "conflict", "in_progress", "operation_in_doubt", "unavailable", "operation_failed":
		default:
			return nil, &Failure{Code: "invalid_response", Uncertain: !ReadOnly(request.Operation)}
		}
		if out.Result != nil && out.Result.Bench != nil {
			b := out.Result.Bench
			if b.Key != request.Key || !filepath.IsAbs(b.Path) || !commitPattern.MatchString(b.Checkpoint) || (b.Lease != nil && ((request.Holder != "" && b.Lease.Holder != request.Holder) || !holderPattern.MatchString(b.Lease.Holder) || !validFailureToken(request, b.Lease.Token) || (b.Lease.Mode != "cooperative" && b.Lease.Mode != "supervised"))) {
				return nil, &Failure{Code: "invalid_result", Uncertain: !ReadOnly(request.Operation)}
			}
		}
		return &out, &Failure{Code: out.Error.Code, Uncertain: out.Error.Code == "operation_in_doubt" || out.Error.Code == "in_progress", Response: &out}
	}
	if err = validateResult(request, out.Result); err != nil {
		return nil, &Failure{Code: "invalid_result", Uncertain: !ReadOnly(request.Operation)}
	}
	return &out, nil
}

var commitPattern = regexp.MustCompile(`^([a-f0-9]{40}|[a-f0-9]{64})$`)

func validateResult(req Request, r *Result) error {
	invalid := errors.New("invalid operation result")
	switch req.Operation {
	case "status":
		if r.Benches == nil {
			return invalid
		}
		for _, b := range r.Benches {
			if !keyPattern.MatchString(b.Key) || b.Lease != nil && b.Lease.Token != "" {
				return invalid
			}
			if req.Key != "" && b.Key != req.Key {
				return invalid
			}
		}
	case "host_status":
	case "release":
		if r.Released != req.Key {
			return invalid
		}
	default:
		if r.Bench == nil || r.Bench.Key != req.Key || !filepath.IsAbs(r.Bench.Path) || !commitPattern.MatchString(r.Bench.Checkpoint) {
			return invalid
		}
		if l := r.Bench.Lease; l != nil {
			if (req.Holder != "" && l.Holder != req.Holder) || (req.LeaseToken != "" && l.Token != "" && l.Token != req.LeaseToken) || !holderPattern.MatchString(l.Holder) || (l.Mode != "cooperative" && l.Mode != "supervised") || (l.Token != "" && !tokenPattern.MatchString(l.Token)) {
				return invalid
			}
		}
		switch req.Operation {
		case "create", "recover":
			if req.Initialize != nil && *req.Initialize && r.Bench.Lease != nil {
				return invalid
			}
		case "lease":
			if r.Bench.Lease == nil || !tokenPattern.MatchString(r.Bench.Lease.Token) {
				return invalid
			}
		case "stop", "stop_admin":
			if r.Bench.Lease == nil || !tokenPattern.MatchString(r.Bench.Lease.Token) || (r.Bench.Lease.Execution != nil && r.Bench.Lease.Execution.Phase != "stopped") {
				return invalid
			}
		case "checkpoint":
			if r.Bench.Lease != nil && r.Bench.Lease.Token != "" {
				return invalid
			}
		}
		if req.Operation == "run" || req.Operation == "setup" {
			if r.Execution == nil || r.Execution.ID == "" || r.Execution.Phase != "stopped" || r.ExitCode == nil || *r.ExitCode != 0 {
				return invalid
			}
			if (req.Operation == "setup" || req.Checkpoint == nil || *req.Checkpoint) && r.Bench.Lease != nil {
				return invalid
			}
			if req.Operation == "run" && req.Checkpoint != nil && !*req.Checkpoint && (r.Bench.Lease == nil || !tokenPattern.MatchString(r.Bench.Lease.Token) || r.Bench.Lease.Execution == nil || r.Bench.Lease.Execution.Phase != "stopped") {
				return invalid
			}
		}
	}
	return nil
}

// strictJSON rejects ambiguous JSON at all depths. V1 explicitly permits new
// response fields, so unknown fields are ignored after lexical validation.
func strictJSON(raw []byte, out any) error {
	if !utf8.Valid(raw) {
		return errors.New("invalid UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	depth := 0
	var walk func() error
	walk = func() error {
		depth++
		defer func() { depth-- }()
		if depth > 128 {
			return errors.New("JSON nesting exceeds bound")
		}
		tok, e := d.Token()
		if e != nil {
			return e
		}
		delim, ok := tok.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]bool{}
			for d.More() {
				k, e := d.Token()
				if e != nil {
					return e
				}
				s, ok := k.(string)
				if !ok || seen[s] {
					return errors.New("duplicate JSON key")
				}
				seen[s] = true
				if e = walk(); e != nil {
					return e
				}
			}
		case '[':
			for d.More() {
				if e := walk(); e != nil {
					return e
				}
			}
		default:
			return errors.New("unexpected delimiter")
		}
		_, e = d.Token()
		return e
	}
	if err := walk(); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	return json.Unmarshal(raw, out)
}

// Known result fields cannot smuggle an unrelated capability across projections;
// genuinely new v1 fields remain forward compatible.
func resultShape(raw []byte, op string, success bool) bool {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(envelope["result"], &fields) != nil {
		return false
	}
	allowed := map[string]bool{}
	switch op {
	case "status":
		allowed["benches"] = true
	case "host_status":
		for _, k := range []string{"managed", "data_free_bytes", "state_free_bytes"} {
			allowed[k] = true
		}
	case "release":
		allowed["released"] = true
	case "run", "setup":
		for _, k := range []string{"bench", "execution", "exit_code", "log_truncated"} {
			allowed[k] = true
		}
	default:
		allowed["bench"] = true
	}
	for _, k := range []string{"bench", "benches", "execution", "exit_code", "log_truncated", "released", "managed", "data_free_bytes", "state_free_bytes"} {
		if value, present := fields[k]; present && (!allowed[k] || (success && bytes.Equal(bytes.TrimSpace(value), []byte("null")))) {
			return false
		}
	}
	return true
}

func responseRequired(raw []byte) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	value := string(fields["ok"])
	if value != "true" && value != "false" {
		return false
	}
	return len(fields["version"]) > 0 && string(fields["version"]) != "null"
}

func validFailureToken(req Request, token string) bool {
	if req.Operation == "checkpoint" {
		return token == ""
	}
	if !tokenPattern.MatchString(token) {
		return false
	}
	return req.LeaseToken == "" || token == req.LeaseToken
}
