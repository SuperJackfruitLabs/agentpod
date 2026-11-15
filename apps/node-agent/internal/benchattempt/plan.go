package benchattempt

import (
	"encoding/json"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

// Pure plan validation preserves the serialized journal identity; it performs
// no filesystem reads, authorization or journal mutation.
func physicalName(p string) bool { return filepath.IsAbs(p) && filepath.Clean(p) == p }

func ValidatePlan(p Plan) error {
	ids := []string{p.Identity.TenantID, p.Identity.BoardID, p.Identity.CardID, p.Identity.StageID, p.Identity.RunID, p.Identity.AgentID, p.Identity.StationID, p.Identity.NodeID, p.Identity.AttemptID, p.Identity.ControlPrincipalID, p.Identity.ControlGrantID, p.HostID, p.RegistrationID}
	for _, s := range ids {
		if !modelID.MatchString(s) {
			return ErrInvalid
		}
	}
	if p.Identity.Epoch == 0 {
		return ErrInvalid
	}
	for _, h := range []string{p.Identity.PolicySHA256, p.RequestSHA256, p.BodySHA256, p.ContextSHA256, p.ExecutableSHA256} {
		if !modelSHA.MatchString(h) {
			return ErrInvalid
		}
	}
	if !ValidSources(p.Sources) || !physicalName(p.ContextPath) || !physicalName(p.ExecutablePath) || len(p.ContextPath) > 4096 || len(p.ExecutablePath) > 4096 {
		return ErrInvalid
	}
	if p.Grouped != nil {
		return validateGroupedPlan(p)
	}
	// Validate the producer's own scalar request identity rules without inventing
	// a held-token run extension. Actual raw arguments are bound at Dispatch.
	raw, _ := json.Marshal(superbench.Request{Version: superbench.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, Arguments: []string{p.ExecutablePath, p.ContextPath}})
	_, err := superbench.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	return nil
}

var groupedMemberName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var groupedRegistration = regexp.MustCompile(`^[a-f0-9]{32}$`)

func validateGroupedPlan(p Plan) error {
	g := p.Grouped
	if !ValidGroupedIdentity(p.Identity) || g == nil || !groupedRegistration.MatchString(p.RegistrationID) || !physicalName(g.WorkspaceRoot) || !utf8.ValidString(g.WorkspaceRoot) || strings.ContainsRune(g.WorkspaceRoot, 0) || len(g.WorkspaceRoot) > 4096 || filepath.Base(g.WorkspaceRoot) != p.BenchKey || filepath.Base(filepath.Dir(g.WorkspaceRoot)) != "benches" || len(g.Members) != len(p.Sources) || p.Identity.Epoch > 1<<53-1 {
		return ErrInvalid
	}
	rel, err := filepath.Rel(g.WorkspaceRoot, p.ContextPath)
	if err != nil || rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ErrInvalid
	}
	selected := g.RepositoryName == ""
	repositories := map[string]bool{}
	for i, m := range g.Members {
		s := p.Sources[i]
		if repositories[m.RepositorySHA256] || !groupedMemberName.MatchString(m.Name) || m.Name != s.Name || m.RepositorySHA256 != s.RepositorySHA256 || m.TaskRef != s.TaskRef || m.Commit != s.Commit || m.TaskRef != "refs/heads/card/"+p.Identity.CardID || (m.ObjectFormat != "sha1" && m.ObjectFormat != "sha256") || m.ObjectFormat == "sha1" && len(m.Commit) != 40 || m.ObjectFormat == "sha256" && len(m.Commit) != 64 {
			return ErrInvalid
		}
		repositories[m.RepositorySHA256] = true
		selected = selected || m.Name == g.RepositoryName
	}
	if !selected {
		return ErrInvalid
	}
	raw, _ := json.Marshal(benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, Arguments: []string{p.ExecutablePath, p.ContextPath, p.ContextSHA256}})
	if _, err = benchworkspace.Parse(raw); err != nil {
		return ErrInvalid
	}
	return nil
}
