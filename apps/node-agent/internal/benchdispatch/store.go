package benchdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Store is host-local private state. Its contents contain no board/service JWT.
// It provides trusted same-UID crash/replay safety, not isolation from that UID.
// Root must be an absolute physical directory with private permissions.
type Store struct{ Root string }

func (s Store) withState(ctx context.Context, p Plan, create bool, fn func(*state) (bool, error)) error {
	if validatePlan(p) != nil || ctx.Err() != nil || !physicalName(s.Root) {
		return ErrInvalid
	}
	if physicalDir(s.Root, true) != nil {
		if !create {
			return ErrInvalid
		}
		if physicalDir(filepath.Dir(s.Root), true) != nil {
			return ErrInvalid
		}
		if err := os.Mkdir(s.Root, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return ErrInvalid
		}
		if physicalDir(s.Root, true) != nil || syncDir(filepath.Dir(s.Root)) != nil {
			return ErrInvalid
		}
	}
	base := digest([]byte(p.BenchKey))
	lockPath := filepath.Join(s.Root, base+".lock")
	if st, e := os.Lstat(lockPath); e == nil && (!st.Mode().IsRegular() || st.Mode().Perm() != 0600) {
		return ErrInvalid
	} else if e != nil && !errors.Is(e, os.ErrNotExist) {
		return ErrInvalid
	}
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return ErrInvalid
	}
	defer f.Close()
	st, err := os.Lstat(lockPath)
	opened, e := f.Stat()
	if err != nil || e != nil || !os.SameFile(st, opened) || !opened.Mode().IsRegular() || opened.Mode().Perm() != 0600 {
		return ErrInvalid
	}
	unlock, err := lock(ctx, f)
	if err != nil {
		return err
	}
	defer unlock()
	path := filepath.Join(s.Root, base+".json")
	raw, err := readFile(path, maxState, true)
	doc := state{Version: version, BenchKey: p.BenchKey, Records: []Record{}}
	if err == nil {
		if decode(raw, &doc) != nil || validateState(doc) != nil {
			return ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) || !create {
		return ErrInvalid
	}
	if doc.BenchKey != p.BenchKey {
		return ErrInvalid
	}
	changed, err := fn(&doc)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if validateState(doc) != nil {
		return ErrInvalid
	}
	raw, err = json.Marshal(doc)
	if err != nil || len(raw) > maxState {
		return ErrInvalid
	}
	return writeAtomic(s.Root, base+".json", raw)
}
func validateState(s state) error {
	if s.Version != version || len(s.Records) > maxRecords {
		return ErrInvalid
	}
	seen := map[string]bool{}
	executions := map[string]bool{}
	active := false
	for _, r := range s.Records {
		id := planID(r.Plan)
		if validatePlan(r.Plan) != nil || r.Plan.BenchKey != s.BenchKey || seen[id] {
			return ErrInvalid
		}
		seen[id] = true
		switch r.Phase {
		case "prepared", "pending", "uncertain", "superseded":
			if len(r.Proposal) != 0 || r.ProposalSHA256 != "" {
				return ErrInvalid
			}
		case "proposed":
			var p Proposal
			if decode(r.Proposal, &p) != nil || p.Version != version || p.PlanSHA256 != planDigest(r.Plan) || !samePlan(p.Plan, r.Plan) || validateObservation(r.Plan, p.Observation) != nil || digest(r.Proposal) != r.ProposalSHA256 {
				return ErrInvalid
			}
			if executions[p.Observation.ExecutionID] {
				return ErrInvalid
			}
			executions[p.Observation.ExecutionID] = true
		default:
			return ErrInvalid
		}
		if r.Phase != "proposed" && id != s.Active {
			return ErrInvalid
		}
		if id == s.Active {
			if r.Phase == "proposed" {
				return ErrInvalid
			}
			active = true
		}
	}
	if s.Active != "" && !active {
		return ErrInvalid
	}
	return nil
}
func find(s *state, p Plan) (*Record, error) {
	for i := range s.Records {
		r := &s.Records[i]
		if planID(r.Plan) == planID(p) {
			if !samePlan(r.Plan, p) {
				return nil, ErrConflict
			}
			return r, nil
		}
	}
	return nil, ErrOwner
}

// Prepare reserves the bench for this exact attempt before any launch. Another
// attempt remains blocked until verified checkpoint/release produced a proposal.
// Superseding an uncertain attempt deliberately does NOT free that reservation.
func (s Store) Prepare(ctx context.Context, p Plan) error {
	return s.withState(ctx, p, true, func(doc *state) (bool, error) {
		if _, err := find(doc, p); err == nil {
			return false, nil
		} else if !errors.Is(err, ErrOwner) {
			return false, err
		}
		for _, r := range doc.Records {
			if (r.Plan.Identity.RunID == p.Identity.RunID && r.Plan.Identity.Epoch == p.Identity.Epoch) || r.Plan.RequestID == p.RequestID {
				return false, ErrConflict
			}
		}
		if doc.Active != "" {
			return false, ErrPending
		}
		if len(doc.Records) >= maxRecords {
			return false, ErrInvalid
		}
		doc.Records = append(doc.Records, Record{Plan: p, Phase: "prepared"})
		doc.Active = planID(p)
		return true, nil
	})
}

// Inspect is a private local projection. It has no continuation capability and
// does not alter ownership, retry operations or claim the board accepted anything.
func (s Store) Inspect(ctx context.Context, p Plan) (Record, error) {
	var result Record
	err := s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		raw, _ := json.Marshal(r)
		if json.Unmarshal(raw, &result) != nil {
			return false, ErrInvalid
		}
		return false, nil
	})
	return result, err
}

// Supersede only parks this exact attempt. It never stops a process, releases a
// lease, clears a later owner, or adopts another run's checkpoint evidence.
func (s Store) Supersede(ctx context.Context, p Plan) error {
	return s.withState(ctx, p, false, func(doc *state) (bool, error) {
		r, e := find(doc, p)
		if e != nil {
			return false, e
		}
		if r.Phase == "proposed" {
			return false, ErrOwner
		}
		if doc.Active != planID(p) {
			return false, ErrOwner
		}
		r.Phase = "superseded"
		return true, nil
	})
}
