package benchdispatch

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

const sourceVersion = "agentpod.private-bench-dispatch.v2"

// SourceSpec reserves a fixed task/host/packaging identity before any source
// growth. It has no repository URLs, arguments, environment or capabilities.
type SourceSpec struct {
	Identity             Identity           `json:"identity"`
	HostID               string             `json:"host_id"`
	BenchKey             string             `json:"bench_key"`
	Holder               string             `json:"holder"`
	ContextParent        string             `json:"context_parent"`
	DataRoot             string             `json:"data_root"`
	CheckpointRepository string             `json:"checkpoint_repository"`
	Repositories         []SourceRepository `json:"repositories"`
	WorkerPath           string             `json:"worker_path"`
	WorkerSHA256         string             `json:"worker_sha256"`
	TaskSHA256           string             `json:"task_sha256"`
	Create               bool               `json:"create"`
	CreateRequestID      string             `json:"create_request_id,omitempty"`
	LeaseRequestID       string             `json:"lease_request_id"`
	RunRequestID         string             `json:"run_request_id"`
}

type SourceRepository struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	Base             string `json:"base"`
	ObjectFormat     string `json:"object_format"`
}

type SourceOperation struct {
	Step           string `json:"step"`
	RequestSHA256  string `json:"request_sha256"`
	BodySHA256     string `json:"body_sha256"`
	ResponseSHA256 string `json:"response_sha256,omitempty"`
	HTTPStatus     int    `json:"http_status,omitempty"`
	Phase          string `json:"phase"`
}

type SourceReservation struct {
	Spec       SourceSpec        `json:"spec"`
	Operations []SourceOperation `json:"operations"`
}

func sourceID(s SourceSpec) string     { raw, _ := json.Marshal(s.Identity); return digest(raw) }
func sourceDigest(s SourceSpec) string { raw, _ := json.Marshal(s); return digest(raw) }
func validSourceSpec(s SourceSpec) bool {
	ids := []string{s.Identity.TenantID, s.Identity.BoardID, s.Identity.CardID, s.Identity.StageID, s.Identity.RunID, s.Identity.AgentID, s.Identity.StationID, s.Identity.NodeID, s.Identity.AttemptID, s.Identity.ControlPrincipalID, s.Identity.ControlGrantID, s.HostID}
	for _, id := range ids {
		if !idPattern.MatchString(id) {
			return false
		}
	}
	if s.Identity.Epoch == 0 || s.Identity.Epoch > 1<<53-1 || !hexPattern.MatchString(s.Identity.PolicySHA256) || !hexPattern.MatchString(s.WorkerSHA256) || !hexPattern.MatchString(s.TaskSHA256) || !physicalName(s.DataRoot) || len(s.DataRoot) > 4096 || !physicalName(s.WorkerPath) || len(s.WorkerPath) > 4096 || len(s.Repositories) < 1 || len(s.Repositories) > 32 {
		return false
	}
	found := false
	seen := map[string]bool{}
	for i, r := range s.Repositories {
		if !groupedMemberName.MatchString(r.Name) || i > 0 && s.Repositories[i-1].Name >= r.Name || !hexPattern.MatchString(r.RepositorySHA256) || seen[r.RepositorySHA256] || r.TaskRef != "refs/heads/card/"+s.Identity.CardID || !validRef(r.TaskRef) || !validRef("refs/heads/"+r.Base) || r.ObjectFormat != "sha1" && r.ObjectFormat != "sha256" {
			return false
		}
		seen[r.RepositorySHA256] = true
		found = found || r.Name == s.CheckpointRepository
	}
	if !physicalName(s.ContextParent) || len(s.ContextParent) > 4096 || !utf8.ValidString(s.ContextParent) || !utf8.ValidString(s.DataRoot) || !utf8.ValidString(s.WorkerPath) || strings.ContainsAny(s.ContextParent+s.DataRoot+s.WorkerPath, "\x00") {
		return false
	}
	rel, e := filepath.Rel(s.DataRoot, s.ContextParent)
	if e != nil || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	if !found || s.LeaseRequestID == s.RunRequestID || s.Create && (s.CreateRequestID == s.LeaseRequestID || s.CreateRequestID == s.RunRequestID) || !s.Create && s.CreateRequestID != "" {
		return false
	}
	for _, id := range []string{s.LeaseRequestID, s.RunRequestID} {
		raw, _ := json.Marshal(benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: s.BenchKey, Holder: s.Holder, RequestID: id})
		if _, err := benchworkspace.Parse(raw); err != nil {
			return false
		}
	}
	if s.Create {
		raw, _ := json.Marshal(benchworkspace.Request{Version: benchworkspace.Version, Operation: "lease", Key: s.BenchKey, Holder: s.Holder, RequestID: s.CreateRequestID})
		if _, err := benchworkspace.Parse(raw); err != nil {
			return false
		}
	}
	return true
}
func sourceSteps(s SourceSpec) []string {
	if s.Create {
		return []string{"create", "lease", "checkpoint"}
	}
	return []string{"lease", "checkpoint"}
}
func validReservation(r *SourceReservation) bool {
	if r == nil || !validSourceSpec(r.Spec) {
		return false
	}
	steps := sourceSteps(r.Spec)
	if len(r.Operations) > len(steps) {
		return false
	}
	for i, o := range r.Operations {
		if o.Step != steps[i] || !hexPattern.MatchString(o.RequestSHA256) || !hexPattern.MatchString(o.BodySHA256) {
			return false
		}
		switch o.Phase {
		case "pending":
			if i != len(r.Operations)-1 || o.ResponseSHA256 != "" || o.HTTPStatus != 0 {
				return false
			}
		case "observed":
			if !hexPattern.MatchString(o.ResponseSHA256) || o.HTTPStatus != 200 {
				return false
			}
		case "failed":
			if i != len(r.Operations)-1 || !hexPattern.MatchString(o.ResponseSHA256) || o.HTTPStatus < 400 || o.HTTPStatus > 599 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func sourcePlanMatches(s SourceSpec, p Plan) bool {
	if p.Grouped == nil || filepath.Dir(p.ContextPath) != s.ContextParent || sourceID(s) != planID(p) || p.HostID != s.HostID || p.BenchKey != s.BenchKey || p.Holder != s.Holder || p.ExecutablePath != s.WorkerPath || p.ExecutableSHA256 != s.WorkerSHA256 || p.RequestID != s.RunRequestID || p.Grouped.WorkspaceRoot != filepath.Join(s.DataRoot, "benches", s.BenchKey) || len(p.Grouped.Members) != len(s.Repositories) {
		return false
	}
	for i, r := range s.Repositories {
		m := p.Grouped.Members[i]
		if r.Name != m.Name || r.RepositorySHA256 != m.RepositorySHA256 || r.TaskRef != m.TaskRef || r.ObjectFormat != m.ObjectFormat {
			return false
		}
	}
	return true
}
func sourceRequestMatches(s SourceSpec, step string, r benchworkspace.Request) bool {
	if r.Version != benchworkspace.Version || r.Operation != step || r.Key != s.BenchKey {
		return false
	}
	switch step {
	case "create":
		if r.QuotaBytes != nil {
			return false
		}
		if !s.Create || r.RequestID != s.CreateRequestID || r.Initialize == nil || !*r.Initialize || r.CheckpointRepository != s.CheckpointRepository || len(r.Repositories) != len(s.Repositories) {
			return false
		}
		for i, want := range s.Repositories {
			got := r.Repositories[i]
			if got.Name != want.Name || digest([]byte(got.Repository)) != want.RepositorySHA256 || got.Branch != strings.TrimPrefix(want.TaskRef, "refs/heads/") || got.Base != want.Base {
				return false
			}
		}
		return true
	case "lease":
		return r.RequestID == s.LeaseRequestID && r.Holder == s.Holder
	case "checkpoint":
		return r.LeaseToken != ""
	}
	return false
}
