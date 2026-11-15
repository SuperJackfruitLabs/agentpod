// Package superbench consumes SuperBench's versioned local socket messages.
package superbench

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"unicode/utf8"
)

const Version = "superbench.v1"
const MaxBody = 64 << 10
const MaxResponse = 1 << 20

type Request struct {
	Version    string   `json:"version"`
	Operation  string   `json:"operation"`
	Key        string   `json:"key,omitempty"`
	Repository string   `json:"repository,omitempty"`
	Branch     string   `json:"branch,omitempty"`
	Base       string   `json:"base,omitempty"`
	Holder     string   `json:"holder,omitempty"`
	RequestID  string   `json:"request_id,omitempty"`
	LeaseToken string   `json:"lease_token,omitempty"`
	Arguments  []string `json:"arguments,omitempty"`
	Checkpoint *bool    `json:"checkpoint,omitempty"`
	Initialize *bool    `json:"initialize,omitempty"`
	Offline    *bool    `json:"offline,omitempty"`
}
type shape struct{ required, optional []string }

var shapes = map[string]shape{
	"create":  {[]string{"key", "repository", "request_id"}, []string{"branch", "base", "initialize"}},
	"recover": {[]string{"key", "repository", "branch", "request_id"}, []string{"base", "initialize"}},
	"status":  {nil, []string{"key"}}, "host_status": {},
	"lease":      {[]string{"key", "holder", "request_id"}, nil},
	"checkpoint": {[]string{"key", "lease_token"}, nil}, "release": {[]string{"key", "lease_token"}, nil},
	"run":   {[]string{"key", "holder", "arguments", "request_id"}, []string{"checkpoint"}},
	"setup": {[]string{"key", "holder", "request_id"}, []string{"offline"}},
	"stop":  {[]string{"key", "lease_token"}, nil}, "stop_admin": {[]string{"key"}, nil},
}
var keyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)
var holderPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$`)
var tokenPattern = regexp.MustCompile(`^([a-f0-9]{32}|[a-f0-9]{48})$`)

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
	var r Request
	invalid := errors.New("invalid operation request")
	if len(raw) > MaxBody || !utf8.Valid(raw) {
		return r, invalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	start, e := d.Token()
	if e != nil || start != json.Delim('{') {
		return r, invalid
	}
	fields := map[string]json.RawMessage{}
	for d.More() {
		token, e := d.Token()
		if e != nil {
			return r, invalid
		}
		key, ok := token.(string)
		if !ok {
			return r, invalid
		}
		if _, exists := fields[key]; exists {
			return r, invalid
		}
		var value json.RawMessage
		if e = d.Decode(&value); e != nil {
			return r, invalid
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return r, invalid
		}
		fields[key] = value
	}
	if _, e = d.Token(); e != nil {
		return r, invalid
	}
	var extra any
	if e = d.Decode(&extra); !errors.Is(e, io.EOF) {
		return r, invalid
	}
	if e = json.Unmarshal(raw, &r); e != nil {
		return Request{}, invalid
	}
	if r.Initialize != nil && !*r.Initialize {
		return r, invalid
	}
	if r.Version != Version {
		return r, invalid
	}
	s, ok := shapes[r.Operation]
	if !ok {
		return r, invalid
	}
	allowed := map[string]bool{"version": true, "operation": true}
	for _, key := range s.required {
		if _, ok = fields[key]; !ok {
			return r, invalid
		}
		allowed[key] = true
	}
	for _, key := range s.optional {
		allowed[key] = true
	}
	for key := range fields {
		if !allowed[key] {
			return r, invalid
		}
	}
	for _, key := range []string{"key", "request_id"} {
		if _, present := fields[key]; present {
			value := r.Key
			if key == "request_id" {
				value = r.RequestID
			}
			if !keyPattern.MatchString(value) {
				return r, invalid
			}
		}
	}
	if _, present := fields["holder"]; present && !holderPattern.MatchString(r.Holder) {
		return r, invalid
	}
	if _, present := fields["lease_token"]; present && !tokenPattern.MatchString(r.LeaseToken) {
		return r, invalid
	}
	for key, limit := range map[string]int{"repository": 4096, "branch": 255, "base": 255} {
		if _, present := fields[key]; present {
			value := r.Repository
			if key == "branch" {
				value = r.Branch
			}
			if key == "base" {
				value = r.Base
			}
			length := utf8.RuneCountInString(value)
			if length < 1 || length > limit {
				return r, invalid
			}
		}
	}
	if r.Repository != "" && r.Repository[0] == '-' {
		return r, invalid
	}
	if rawArguments, present := fields["arguments"]; present {
		// Unmarshalling into []string accepts null as an empty string. Check the
		// wire item types before admitting the decoded command arguments.
		var items []json.RawMessage
		if json.Unmarshal(rawArguments, &items) != nil || len(items) != len(r.Arguments) {
			return r, invalid
		}
		for _, item := range items {
			if item = bytes.TrimSpace(item); len(item) == 0 || item[0] != '"' {
				return r, invalid
			}
		}
		if len(r.Arguments) < 1 || len(r.Arguments) > 128 || r.Arguments[0] == "" {
			return r, invalid
		}
		for _, value := range r.Arguments {
			if utf8.RuneCountInString(value) > 8192 {
				return r, invalid
			}
		}
	}
	return r, nil
}
func (r Request) Digest() (string, error) {
	raw, e := json.Marshal(r)
	if e != nil {
		return "", e
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}
