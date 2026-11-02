package forgeapi

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi/stkpolicy"
)

// PruneStation removes one registered station's whole instance (the CLI's `forge-api prune`), or,
// with dryRun, only says what it would remove. A station the registry does not list is (_, false)
// and nothing is touched. It is the manual counterpart of PruneUnhosted, which no automatic
// trigger calls.
func (m *StationInstances) PruneStation(ctx context.Context, station string, dryRun bool) (Instance, bool, error) {
	recs, err := m.readRecords()
	if err != nil {
		return Instance{}, false, err
	}
	r, ok := recs[station]
	if !ok {
		return Instance{}, false, nil
	}
	inst := m.instanceFor(r)
	if dryRun {
		return inst, true, nil
	}
	var others []string
	for st := range recs {
		if st != station {
			others = append(others, st)
		}
	}
	_, err = m.PruneUnhosted(ctx, others)
	return inst, true, err
}

// PruneUnhosted removes the whole instance (unit, state, runtime, policy, user) of every
// registered station that is not in hosted, and returns those stations. Only instances in the
// registry are touched, and only by names of the shape the node itself makes. It is idempotent: a
// step that was already done is skipped, and a failed one leaves the registry entry so the next
// call finishes the job.
func (m *StationInstances) PruneUnhosted(ctx context.Context, hosted []string) ([]string, error) {
	keep := map[string]bool{}
	for _, h := range hosted {
		keep[h] = true
	}
	recs, err := m.readRecords()
	if err != nil {
		return nil, err
	}
	var stale []record
	m.mu.Lock()
	for st, r := range recs {
		if !keep[st] && !m.removing[st] {
			stale = append(stale, r)
		}
	}
	for _, r := range stale {
		m.removing[r.Station] = true
	}
	m.mu.Unlock()
	sort.Slice(stale, func(i, j int) bool { return stale[i].Port < stale[j].Port })

	var gone []string
	var errs []error
	for _, r := range stale {
		if err := m.removeInstance(ctx, r); err != nil {
			errs = append(errs, fmt.Errorf("station %s: %w", r.Station, err))
		} else {
			gone = append(gone, r.Station)
		}
		m.mu.Lock()
		delete(m.removing, r.Station)
		m.mu.Unlock()
	}
	return gone, errors.Join(errs...)
}

func (m *StationInstances) removeInstance(ctx context.Context, r record) error {
	inst := m.instanceFor(r)
	m.mu.Lock()
	st := m.states[r.Station]
	m.mu.Unlock()
	if st != nil {
		unlock := st.svc.lockForRemoval()
		defer unlock()
	}
	// The harness wiring first: it points at the instance about to go.
	if m.cfg.Harness != nil {
		m.wiringMu.Lock()
		_, err := m.unwireInstance(ctx, inst)
		m.wiringMu.Unlock()
		if err != nil {
			return coded("unwire-failed", err)
		}
	}
	if m.cfg.Unwire != nil {
		data, _, err := stkpolicy.ReadPolicyFile(inst.ConfigPath)
		if err != nil {
			return coded("policy-read-failed", err)
		}
		entries, err := stkpolicy.ManagedEntries(data)
		if err != nil {
			return coded("policy-invalid", err)
		}
		for _, e := range entries {
			if err := m.cfg.Unwire(e.Grant); err != nil {
				return coded("unwire-failed", err)
			}
		}
	}
	lc := m.cfg.Lifecycle
	steps := []struct {
		what string
		do   func() error
	}{
		{"stop unit", func() error { return lc.StopDisable(ctx, inst.Unit()) }},
		{"remove unit", func() error { return lc.RemoveUnit(ctx, inst.Unit()) }},
		{"remove user", func() error { return lc.RemoveUser(ctx, inst.User()) }},
		{"remove state", func() error { return lc.RemoveTree(ctx, inst.StateDir) }},
		{"remove runtime dir", func() error { return lc.RemoveTree(ctx, inst.RuntimeDir) }},
		{"remove config", func() error { return lc.RemoveTree(ctx, filepath.Dir(inst.ConfigPath)) }},
	}
	for _, s := range steps {
		if err := s.do(); err != nil {
			return coded("instance-remove-failed", fmt.Errorf("%s: %w", s.what, err))
		}
	}
	// The host is clean. Drop the record from the registry as it is now (another process may have
	// added records since it was read); on a write failure the record stays so a retry finishes.
	if err := m.updateRecords(func(recs map[string]record) (bool, error) {
		cur, ok := recs[r.Station]
		if !ok || cur.Name != r.Name {
			return false, nil
		}
		delete(recs, r.Station)
		return true, nil
	}); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.states, r.Station)
	delete(m.seedWarn, r.Station)
	delete(m.warned, r.Station)
	m.mu.Unlock()
	logf("forgeapi: removed the stk instance of station %s", r.Station)
	return nil
}
