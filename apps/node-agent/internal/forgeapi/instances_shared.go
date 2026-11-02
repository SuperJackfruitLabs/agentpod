package forgeapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi/stkpolicy"
)

// ---- shared base policy refresh ----

// sharedFingerprint is a cheap change detector for the shared base policy file ("" when absent).
func (m *StationInstances) sharedFingerprint() (string, error) {
	b, existed, err := stkpolicy.ReadPolicyFile(m.cfg.SharedPolicyPath)
	if err != nil {
		return "", err
	}
	if !existed {
		return "absent", nil
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// refreshBackoff is how long a station whose shared-policy refresh failed is left alone.
const refreshBackoff = 60 * time.Second

// maybeRefreshShared brings every registered instance in line with the shared base policy when it
// differs from what that instance last had applied. Called before deliver, policy and status for
// ANY station (and at node start), so a service the operator removed is gone from every station's
// policy, credential forgotten first, without waiting for that station's own next write.
//
// The fingerprint is kept PER STATION: a station that is current is skipped, and one that failed
// is left alone for refreshBackoff, so one broken station never makes every later frame redo the
// refresh of all the others (or of itself, in a tight loop).
func (m *StationInstances) maybeRefreshShared(ctx context.Context) {
	if m.env.goos != "linux" || m.env.euid != 0 {
		return // such a node has no instances to refresh
	}
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()
	fp, err := m.sharedFingerprint()
	if err != nil {
		logf("forgeapi: shared base policy unreadable: %v", clean(err.Error()))
		return
	}
	if err := m.refreshAllShared(ctx, fp); err != nil {
		logf("forgeapi: shared base policy not refreshed everywhere: %v", clean(err.Error()))
	}
}

// RefreshShared refreshes every registered instance now (the node calls it once at start).
func (m *StationInstances) RefreshShared(ctx context.Context) {
	if m == nil {
		return
	}
	m.maybeRefreshShared(ctx)
}

func (m *StationInstances) refreshAllShared(ctx context.Context, fp string) error {
	recs, err := m.readRecords()
	if err != nil {
		return err
	}
	if m.sharedFP == nil {
		m.sharedFP, m.sharedRetry = map[string]string{}, map[string]time.Time{}
	}
	var errs []error
	now := m.clockNow()
	for station, r := range recs {
		if m.sharedFP[station] == fp || now.Before(m.sharedRetry[station]) {
			continue
		}
		m.mu.Lock()
		removing := m.removing[station]
		st := m.states[station]
		if st == nil && !removing {
			st = m.build(m.instanceFor(r))
			m.states[station] = st
		}
		m.mu.Unlock()
		if removing || !m.cfg.userExists(st.inst.User()) {
			continue // being removed, or never installed: no policy to refresh
		}
		if m.cfg.onRefresh != nil {
			m.cfg.onRefresh(station)
		}
		if err := st.svc.RefreshShared(ctx); err != nil {
			m.sharedRetry[station] = now.Add(refreshBackoff)
			errs = append(errs, fmt.Errorf("station %s: %w", station, err))
			continue
		}
		m.sharedFP[station] = fp
		delete(m.sharedRetry, station)
	}
	return errors.Join(errs...)
}
