package benchdispatch

import (
	"encoding/json"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func sourceTaskMatchesContext(spec SourceSpec, p Plan) bool {
	raw, e := readFile(filepath.Join(p.ContextPath, "request.json"), superbench.MaxWorker, true)
	if e != nil || digest(raw) != p.ContextSHA256 {
		return false
	}
	var worker superbench.GroupedWorkerSpec
	if json.Unmarshal(raw, &worker) != nil {
		return false
	}
	return SourceTaskSHA256(SourceTask{Arguments: worker.Arguments, Prompt: worker.Prompt, Environment: worker.Environment, TimeoutSeconds: worker.TimeoutSeconds, RepositoryName: worker.RepositoryName}) == spec.TaskSHA256
}

// Source evidence remains required for a first dispatch or lost-reply lookup.
// Historical immutable proposals can still replay without reviving a grant.
func (s Store) boundSourceEvidence(record *Record) error {
	if record.Source == nil {
		return nil
	}
	r := record.Source
	p := record.Plan
	if !validReservation(r) || !sourcePlanMatches(r.Spec, p) {
		return ErrInvalid
	}
	var lease, cp, created *benchworkspace.Mutation
	for _, op := range r.Operations {
		if op.Phase != "observed" {
			return ErrPending
		}
		reply, e := s.observedSourceReply(r.Spec, op)
		if e != nil {
			return e
		}
		switch op.Step {
		case "create":
			created = sourceMutation(reply)
		case "lease":
			lease = sourceMutation(reply)
		case "checkpoint":
			cp = sourceMutation(reply)
		}
	}
	if !validHeldSource(r.Spec, lease) || lease.Grant == nil || !validHeldSource(r.Spec, cp) || lease.RootPath != p.Grouped.WorkspaceRoot || lease.Workspace.BenchID != p.RegistrationID || cp.Workspace.BenchID != p.RegistrationID || cp.Workspace.Checkpoint == nil || len(cp.Workspace.Checkpoint.Members) != len(p.Sources) {
		return ErrVerify
	}
	if created != nil && (created.Workspace.BenchID != p.RegistrationID || created.RootPath != p.Grouped.WorkspaceRoot) {
		return ErrVerify
	}
	for i, c := range cp.Workspace.Checkpoint.Members {
		if c.Name != p.Sources[i].Name || c.Commit != p.Sources[i].Commit {
			return ErrVerify
		}
	}
	return nil
}
