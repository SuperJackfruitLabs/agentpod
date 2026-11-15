// Package benchsource validates private source preparation models without effects.
package benchsource

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

type SourceSpec = benchattempt.SourceSpec
type SourceReservation = benchattempt.SourceReservation
type Plan = benchattempt.Plan

var identityPattern = regexp.MustCompile(benchattempt.IDPattern)
var shaPattern = regexp.MustCompile(benchattempt.SHA256Pattern)
var groupedMemberName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

func physicalName(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }
func ValidSpec(s SourceSpec) bool {
	ids := []string{s.Identity.TenantID, s.Identity.BoardID, s.Identity.CardID, s.Identity.StageID, s.Identity.RunID, s.Identity.AgentID, s.Identity.StationID, s.Identity.NodeID, s.Identity.AttemptID, s.Identity.ControlPrincipalID, s.Identity.ControlGrantID, s.HostID}
	for _, id := range ids {
		if !identityPattern.MatchString(id) {
			return false
		}
	}
	if !benchattempt.ValidGroupedIdentity(s.Identity) || s.Identity.Epoch == 0 || s.Identity.Epoch > 1<<53-1 || !shaPattern.MatchString(s.Identity.PolicySHA256) || !shaPattern.MatchString(s.WorkerSHA256) || !shaPattern.MatchString(s.TaskSHA256) || !physicalName(s.DataRoot) || len(s.DataRoot) > 4096 || !physicalName(s.WorkerPath) || len(s.WorkerPath) > 4096 || len(s.Repositories) < 1 || len(s.Repositories) > 32 {
		return false
	}
	found := false
	seen := map[string]bool{}
	for i, r := range s.Repositories {
		if !groupedMemberName.MatchString(r.Name) || i > 0 && s.Repositories[i-1].Name >= r.Name || !shaPattern.MatchString(r.RepositorySHA256) || seen[r.RepositorySHA256] || r.TaskRef != "refs/heads/card/"+s.Identity.CardID || !benchattempt.ValidRef(r.TaskRef) || !benchattempt.ValidRef("refs/heads/"+r.Base) || r.ObjectFormat != "sha1" && r.ObjectFormat != "sha256" {
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

func ValidReservation(r *SourceReservation) bool {
	if r == nil || !ValidSpec(r.Spec) {
		return false
	}
	steps := benchattempt.SourceSteps(r.Spec)
	if len(r.Operations) > len(steps) {
		return false
	}
	for i, o := range r.Operations {
		if o.Step != steps[i] || !shaPattern.MatchString(o.RequestSHA256) || !shaPattern.MatchString(o.BodySHA256) {
			return false
		}
		switch o.Phase {
		case "pending":
			if i != len(r.Operations)-1 || o.ResponseSHA256 != "" || o.HTTPStatus != 0 {
				return false
			}
		case "observed":
			if !shaPattern.MatchString(o.ResponseSHA256) || o.HTTPStatus != 200 {
				return false
			}
		case "failed":
			if i != len(r.Operations)-1 || !shaPattern.MatchString(o.ResponseSHA256) || o.HTTPStatus < 400 || o.HTTPStatus > 599 {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func PlanMatches(s SourceSpec, p Plan) bool {
	if p.Grouped == nil || filepath.Dir(p.ContextPath) != s.ContextParent || benchattempt.SourceIdentitySHA256(s) != benchattempt.PlanIdentitySHA256(p) || p.HostID != s.HostID || p.BenchKey != s.BenchKey || p.Holder != s.Holder || p.ExecutablePath != s.WorkerPath || p.ExecutableSHA256 != s.WorkerSHA256 || p.RequestID != s.RunRequestID || p.Grouped.WorkspaceRoot != filepath.Join(s.DataRoot, "benches", s.BenchKey) || len(p.Grouped.Members) != len(s.Repositories) {
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
func RequestMatches(s SourceSpec, step string, r benchworkspace.Request) bool {
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
			if got.Name != want.Name || benchattempt.RawSHA256([]byte(got.Repository)) != want.RepositorySHA256 || got.Branch != strings.TrimPrefix(want.TaskRef, "refs/heads/") || got.Base != want.Base {
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
