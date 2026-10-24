// Package stationfs implements the private, traversal-resistant station file
// primitive. It grants no principal or run authority; Salaam's durable controller
// must admit each invocation. Commands never receive the writable source root.
package stationfs

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

type Request struct {
	effectPossible *bool
	// createdDirs collects the parent directories a patch created, for its recorded effect.
	createdDirs  *[]string
	deadline     time.Time
	Version      int     `json:"version"`
	Query        string  `json:"query,omitempty"`
	Action       string  `json:"action"`
	RootIdentity string  `json:"root_identity"`
	Root         string  `json:"root"`
	Path         string  `json:"path,omitempty"`
	Offset       int     `json:"offset,omitempty"`
	ExpectedTree string  `json:"expected_tree,omitempty"`
	ExpectedHash *string `json:"expected_hash,omitempty"`
	Content      *string `json:"content,omitempty"`
	Snapshot     string  `json:"snapshot,omitempty"`
	RequestID    string  `json:"request_id,omitempty"`
	DeadlineMs   int64   `json:"deadline_ms,omitempty"`
}

// Entry is deliberately separate from node configuration/enrollment and inherits
// no environment-based authority. A closed JSON request arrives on private stdin.
func Entry(in io.Reader, out, errOut io.Writer) int {
	data, err := io.ReadAll(io.LimitReader(in, 2*1024*1024+1))
	if err != nil || len(data) > 2*1024*1024 {
		return failure(out, "station_request_invalid")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	var request Request
	if err := d.Decode(&request); err != nil {
		return failure(out, "station_request_invalid")
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) || request.Version != 1 {
		return failure(out, "station_request_invalid")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return failure(out, "station_request_invalid")
	}
	allowed := map[string]string{"inspect": "version action root root_identity", "list": "version action root root_identity offset", "search": "version action root root_identity query offset", "read": "version action root root_identity path", "snapshot": "version action root root_identity expected_tree snapshot request_id", "patch": "version action root root_identity expected_tree expected_hash content path request_id deadline_ms"}
	keys, ok := allowed[request.Action]
	if !ok {
		return failure(out, "station_request_invalid")
	}
	for k := range fields {
		if !strings.Contains(" "+keys+" ", " "+k+" ") {
			return failure(out, "station_request_invalid")
		}
	}
	effectPossible := false
	request.effectPossible = &effectPossible
	createdDirs := []string{}
	request.createdDirs = &createdDirs
	if request.Action == "patch" {
		remaining := time.Until(time.UnixMilli(request.DeadlineMs))
		if remaining > 0 && remaining <= 5*time.Second {
			request.deadline = time.Now().Add(remaining)
		}
	}
	result, err := execute(request)
	if err != nil {
		state := "not_started"
		if effectPossible {
			state = "unknown"
		}
		_ = json.NewEncoder(out).Encode(map[string]any{"version": 1, "ok": false, "code": "station_files_unavailable", "effect_state": state})
		return 1
	}
	if json.NewEncoder(out).Encode(result) != nil {
		return 1
	}
	return 0
}

func failure(out io.Writer, code string) int {
	_ = json.NewEncoder(out).Encode(map[string]any{"version": 1, "ok": false, "code": code})
	return 1
}
