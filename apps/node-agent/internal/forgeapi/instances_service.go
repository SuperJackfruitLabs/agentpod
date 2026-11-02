package forgeapi

import (
	"context"
	"strings"
)

// ---- the verbs, routed by station ----

func (m *StationInstances) Deliver(ctx context.Context, p DeliverParams) (DeliverAck, error) {
	m.dropProbe(p.StationID)
	// A bad frame must not cost an instance.
	if _, err := validateDeliver(p); err != nil {
		return DeliverAck{}, err
	}
	if err := m.checkHosted(p.StationKey); err != nil {
		return DeliverAck{}, err
	}
	m.maybeRefreshShared(ctx)
	// A key that already belongs to another station, or a station taking a different key than the
	// one it has, is refused before an instance is created.
	if err := m.checkKeyFree(p.StationID, p.StationKey); err != nil {
		return DeliverAck{}, err
	}
	// Every wiring check that can be made without the credential is made before it is stored.
	if err := m.precheckWiring(p.StationID, p.StationKey); err != nil {
		return DeliverAck{}, err
	}
	st, iso, err := m.lookup(p.StationID, true)
	if err != nil {
		return DeliverAck{}, err
	}
	ack, err := st.svc.Deliver(ctx, p)
	if err != nil {
		return ack, err
	}
	iso.degrade(&ack.Isolation, &ack.IsolationDetail, &ack.Reason)
	// The harness is wired only once stk holds the credential. A failure here is the deliver's
	// failure: the grant would otherwise look usable while the agent has no route to it.
	res, werr := m.wireStation(ctx, st, p.StationKey)
	if werr != nil {
		// The credential is stored and the entry is in the policy: take both out again, so a
		// grant the hub is told failed is not left brokered. The hub redelivers to try again.
		if rerr := st.svc.RollbackGrant(ctx, p.StationID, p.GrantID); rerr != nil {
			return DeliverAck{}, codedf("harness-wiring-failed", "%s; ROLLBACK FAILED, stk may still broker this grant: %s", clean(werr.Error()), clean(rerr.Error()))
		}
		if _, cerr := m.wireStation(ctx, st, ""); cerr != nil {
			logf("forgeapi: could not clear the harness wiring of station %s after a failed deliver: %v", clean(p.StationID), clean(cerr.Error()))
		}
		return DeliverAck{}, werr
	}
	ack.NeedsRestart, ack.Wired = res.restart, res.wired
	return ack, nil
}

func (m *StationInstances) Policy(ctx context.Context, p PolicyParams) (PolicyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return PolicyAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	m.dropProbe(p.StationID)
	m.maybeRefreshShared(ctx)
	st, _, err := m.lookup(p.StationID, false)
	if err != nil {
		return PolicyAck{OK: false, Error: err.Error()}, nil
	}
	if st == nil {
		return PolicyAck{OK: false, Error: "unknown-grant"}, nil
	}
	return st.svc.Policy(ctx, p)
}

func (m *StationInstances) Verify(ctx context.Context, p VerifyParams) (VerifyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" || strings.TrimSpace(p.ExpectLogin) == "" {
		return VerifyAck{}, codedf("invalid-params", "stationId, grantId and expectLogin are required")
	}
	st, iso, err := m.lookup(p.StationID, false)
	if err != nil {
		return VerifyAck{}, err
	}
	if st == nil {
		return VerifyAck{}, codedf("unknown-grant", "this node holds no entry for grant %s", p.GrantID)
	}
	ack, err := st.svc.Verify(ctx, p)
	if err != nil {
		return ack, err
	}
	iso.degrade(&ack.Isolation, &ack.IsolationDetail, nil)
	// What the node wired, beside what was measured: the ack never implies brokered coverage the
	// node did not set up.
	if ack.Bypass == nil {
		ack.Bypass = &BypassReport{Clients: []ClientOutcome{}}
	}
	harness, paths, blocked := m.coverage(p.StationID)
	ack.Bypass.Harness, ack.Bypass.Paths, ack.Bypass.WiringBlocked = harness, paths, blocked
	ack.Bypass.finalize()
	ack.applyCoverage()
	return ack, nil
}

func (m *StationInstances) Revoke(ctx context.Context, p RevokeParams) (RevokeAck, error) {
	m.dropProbe(p.StationID)
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return RevokeAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	st, _, err := m.lookup(p.StationID, false)
	if err != nil {
		return RevokeAck{}, err
	}
	if st == nil {
		// No instance, so nothing stored; the wiring may still be left from an interrupted revoke.
		if m.cfg.Unwire != nil {
			if err := m.cfg.Unwire(p.GrantID); err != nil {
				return RevokeAck{}, coded("unwire-failed", err)
			}
		}
		return RevokeAck{Removed: false}, nil
	}
	ack, err := st.svc.Revoke(ctx, p)
	if err != nil {
		return ack, err
	}
	// Whatever the revoke found, leave the harness wiring as the grants that remain say (an
	// interrupted revoke is healed by the next one).
	res, werr := m.wireStation(ctx, st, "")
	if werr != nil {
		return RevokeAck{}, coded("unwire-failed", werr)
	}
	ack.NeedsRestart, ack.Wired = res.restart, res.wired
	return ack, nil
}

// Status creates the station's instance if there is none: the hub fetches the station's public
// key through status before the first grant, and the key belongs to the instance's own store.
// On a node that cannot create it, status fails with `station-instance-unavailable`; on a node
// where the station shares an agent uid with another, with `station-uid-shared` unless
// acknowledged. A problem seeding the shared base policy is reported in `warnings`.
func (m *StationInstances) Status(ctx context.Context, p StatusParams) (StatusAck, error) {
	if key := m.keyOf(p.StationID); key != "" {
		if err := m.checkHosted(key); err != nil {
			return StatusAck{}, err
		}
	}
	m.maybeRefreshShared(ctx)
	st, iso, err := m.lookup(p.StationID, true)
	if err != nil {
		return StatusAck{}, err
	}
	ack, err := st.svc.Status(ctx, p)
	if err != nil {
		return ack, err
	}
	for i := range ack.Grants {
		iso.degrade(&ack.Grants[i].Isolation, &ack.Grants[i].IsolationDetail, nil)
	}
	if iso.Shared {
		ack.Warnings = append(ack.Warnings, sharedUIDMessage)
	} else if iso.NodeUID {
		ack.Warnings = append(ack.Warnings, nodeUIDMessage)
	}
	m.mu.Lock()
	if w := m.seedWarn[p.StationID]; w != "" {
		ack.Warnings = append(ack.Warnings, w)
	}
	m.mu.Unlock()
	return ack, nil
}

// checkHosted refuses a key the node does not itself detect.
func (m *StationInstances) checkHosted(key string) error {
	if m.cfg.Hosted == nil {
		return nil
	}
	if strings.TrimSpace(key) == "" || !m.cfg.Hosted(key) {
		return codedf("station-not-hosted", "this node does not host a station with the key %s, so it will not create a broker for it", clean(key))
	}
	return nil
}
