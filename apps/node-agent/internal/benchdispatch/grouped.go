package benchdispatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

var groupedMemberName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var groupedBindingID = regexp.MustCompile(`^(brd|card|run)_[A-Za-z0-9]{6,}$`)
var groupedRegistration = regexp.MustCompile(`^[a-f0-9]{32}$`)

// Match the packaged grouped worker's binding grammar before any growth.
func validGroupedIdentity(identity Identity) bool {
	for i, id := range []string{identity.BoardID, identity.CardID, identity.RunID} {
		if !groupedBindingID.MatchString(id) || !strings.HasPrefix(id, []string{"brd_", "card_", "run_"}[i]) {
			return false
		}
	}
	return true
}

func validateGroupedPlan(p Plan) error {
	g := p.Grouped
	if !validGroupedIdentity(p.Identity) || g == nil || !groupedRegistration.MatchString(p.RegistrationID) || !physicalName(g.WorkspaceRoot) || !utf8.ValidString(g.WorkspaceRoot) || strings.ContainsRune(g.WorkspaceRoot, 0) || len(g.WorkspaceRoot) > 4096 || filepath.Base(g.WorkspaceRoot) != p.BenchKey || filepath.Base(filepath.Dir(g.WorkspaceRoot)) != "benches" || len(g.Members) != len(p.Sources) || p.Identity.Epoch > 1<<53-1 {
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

func validateGroupedLaunch(p Plan, raw []byte) error {
	r, err := benchworkspace.Parse(raw)
	if err != nil {
		return ErrInvalid
	}
	body, err := r.Digest()
	if err != nil || body != p.BodySHA256 || r.Operation != "run" || r.Key != p.BenchKey || r.Holder != p.Holder || r.RequestID != p.RequestID || r.LeaseToken == "" || r.RepositoryName != "" || len(r.Arguments) != 3 || r.Arguments[0] != p.ExecutablePath || r.Arguments[1] != p.ContextPath || r.Arguments[2] != p.ContextSHA256 || r.Checkpoint != nil && !*r.Checkpoint {
		return ErrInvalid
	}
	if physicalDir(p.ContextPath, true) != nil {
		return ErrInvalid
	}
	contextRaw, err := readFile(filepath.Join(p.ContextPath, "request.json"), superbench.MaxWorker, true)
	if err != nil || digest(contextRaw) != p.ContextSHA256 || !utf8.Valid(contextRaw) {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(contextRaw))
	if unique(d, 0, false) != nil {
		return ErrInvalid
	}
	if _, err = d.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	var spec superbench.GroupedWorkerSpec
	d = json.NewDecoder(bytes.NewReader(contextRaw))
	d.DisallowUnknownFields()
	if d.Decode(&spec) != nil || spec.Version != superbench.GroupedWorkerVersion || spec.Binding.BoardID != p.Identity.BoardID || spec.Binding.CardID != p.Identity.CardID || spec.Binding.RunID != p.Identity.RunID || spec.Binding.Epoch != p.Identity.Epoch || spec.BenchKey != p.BenchKey || spec.BenchID != p.RegistrationID || spec.WorkspaceRoot != p.Grouped.WorkspaceRoot || spec.RepositoryName != p.Grouped.RepositoryName || !reflect.DeepEqual(spec.Members, p.Grouped.Members) {
		return ErrInvalid
	}
	// This binds the exact launch and context; actual checkout/preparation checks
	// remain the protected worker's job inside benchd.run, never a ledger claim.
	real, err := filepath.EvalSymlinks(p.ExecutablePath)
	if err != nil || real != p.ExecutablePath {
		return ErrInvalid
	}
	binary, err := readFile(p.ExecutablePath, 64<<20, false)
	if err != nil || digest(binary) != p.ExecutableSHA256 {
		return ErrInvalid
	}
	return nil
}
