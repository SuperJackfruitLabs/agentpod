package benchdispatch

import (
	"context"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func sourceMutation(reply *benchworkspace.Response) *benchworkspace.Mutation {
	if reply == nil || !reply.OK {
		return nil
	}
	m, _ := reply.Result.(*benchworkspace.Mutation)
	return m
}
func validHeldSource(spec SourceSpec, m *benchworkspace.Mutation) bool {
	if m == nil {
		return false
	}
	w := m.Workspace
	return w.Key == spec.BenchKey && w.Phase == "ready" && w.TransferState == "" && w.Pending == nil && w.Archive == nil && w.MemberCount == len(spec.Repositories) && w.CheckpointRepository == spec.CheckpointRepository && w.Lease != nil && w.Lease.Holder == spec.Holder && (w.Lease.Mode == "cooperative" || w.Lease.Mode == "supervised") && (w.Lease.Execution == nil || w.Lease.Execution.Phase == "stopped") && !w.Lease.StopRequested
}

// SourceCheckpoint derives the protected start vector from independently parsed
// actual lease and checkpoint replies. No report flags or caller vector can
// stand in for those private producer observations.
func (s Store) SourceCheckpoint(ctx context.Context, spec SourceSpec) (*benchworkspace.Mutation, []superbench.GroupedMember, error) {
	var cp *benchworkspace.Mutation
	var members []superbench.GroupedMember
	err := s.withSource(ctx, spec, func(_ *state, r *SourceReservation) (bool, error) {
		if len(r.Operations) != len(sourceSteps(spec)) {
			return false, ErrPending
		}
		var lease, created *benchworkspace.Mutation
		for _, op := range r.Operations {
			if op.Phase != "observed" {
				return false, ErrPending
			}
			reply, e := s.observedSourceReply(spec, op)
			if e != nil {
				return false, e
			}
			m := sourceMutation(reply)
			switch op.Step {
			case "create":
				created = m
				if m == nil || m.Workspace.Phase != "ready" || m.Workspace.Lease != nil || m.Workspace.Pending != nil {
					return false, ErrVerify
				}
			case "lease":
				lease = m
			case "checkpoint":
				cp = m
			}
		}
		if created != nil && (lease == nil || created.Workspace.BenchID != lease.Workspace.BenchID || created.RootPath != lease.RootPath) {
			return false, ErrVerify
		}
		if !validHeldSource(spec, lease) || lease.Grant == nil || lease.RootPath != filepath.Join(spec.DataRoot, "benches", spec.BenchKey) || !validHeldSource(spec, cp) || cp.Workspace.BenchID != lease.Workspace.BenchID || cp.Workspace.Checkpoint == nil || len(cp.Workspace.Checkpoint.Members) != len(spec.Repositories) {
			return false, ErrVerify
		}
		if physicalDir(lease.RootPath, false) != nil {
			return false, ErrInvalid
		}
		for i, repo := range spec.Repositories {
			c := cp.Workspace.Checkpoint.Members[i]
			if c.Name != repo.Name || repo.ObjectFormat == "sha1" && len(c.Commit) != 40 || repo.ObjectFormat == "sha256" && len(c.Commit) != 64 {
				return false, ErrVerify
			}
			members = append(members, superbench.GroupedMember{Name: repo.Name, RepositorySHA256: repo.RepositorySHA256, TaskRef: repo.TaskRef, ObjectFormat: repo.ObjectFormat, Commit: c.Commit})
		}
		// Root is allowed once at the private source binding, never in shared proof.
		cp.RootPath = lease.RootPath
		return false, nil
	})
	return cp, members, err
}

// BindSource atomically replaces a source reservation with a full immutable
// protected launch. It rereads private producer evidence under the SAME bench
// lock before validating current authority and committing runnable preparation.
func (s Store) BindSource(ctx context.Context, spec SourceSpec, p Plan, rawRun []byte, gate SourceGate) error {
	if gate == nil || validatePlan(p) != nil || !sourcePlanMatches(spec, p) || digest(rawRun) != p.RequestSHA256 || validateLaunch(p, rawRun) != nil || !sourceTaskMatchesContext(spec, p) {
		return ErrInvalid
	}
	return s.withSource(ctx, spec, func(doc *state, r *SourceReservation) (bool, error) {
		if len(r.Operations) != len(sourceSteps(spec)) {
			return false, ErrPending
		}
		var lease, cp, created *benchworkspace.Mutation
		for _, op := range r.Operations {
			if op.Phase != "observed" {
				return false, ErrPending
			}
			reply, e := s.observedSourceReply(spec, op)
			if e != nil {
				return false, e
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
		if created != nil && (lease == nil || created.Workspace.BenchID != lease.Workspace.BenchID || created.RootPath != lease.RootPath) {
			return false, ErrVerify
		}
		if !validHeldSource(spec, lease) || lease.Grant == nil || lease.RootPath != p.Grouped.WorkspaceRoot || !validHeldSource(spec, cp) || cp.Workspace.BenchID != p.RegistrationID || lease.Workspace.BenchID != p.RegistrationID || cp.Workspace.Checkpoint == nil || len(cp.Workspace.Checkpoint.Members) != len(p.Sources) {
			return false, ErrVerify
		}
		run, e := benchworkspace.Parse(rawRun)
		if e != nil || run.LeaseToken != lease.Grant.LeaseToken {
			return false, ErrOwner
		}
		for i, c := range cp.Workspace.Checkpoint.Members {
			if p.Sources[i].Name != c.Name || p.Sources[i].Commit != c.Commit {
				return false, ErrVerify
			}
		}
		if gate(ctx, spec) != nil || ctx.Err() != nil {
			return false, ErrOwner
		}
		doc.Records = append(doc.Records, Record{Plan: p, Source: r, Phase: "prepared"})
		doc.Source = nil
		return true, nil
	})
}
