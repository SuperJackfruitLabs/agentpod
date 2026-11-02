package forgeapi

import (
	"context"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi/stkpolicy"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// ---- per-station state ----

// lookup returns the station's state. With create it registers the station (name, port, uids; no
// instance on the host yet) under the registry lock, refusing `station-uid-shared` when its agents
// share a uid with another registered station and the operator has not acknowledged that. shared
// reports an acknowledged overlap. A station with no record and create unset is (nil, false, nil).
func (m *StationInstances) lookup(station string, create bool) (st *stationState, iso isolationInfo, err error) {
	if err := checkStationID(station); err != nil {
		return nil, isolationInfo{}, err
	}
	m.mu.Lock()
	removing := m.removing[station]
	m.mu.Unlock()
	if removing {
		return nil, isolationInfo{}, codedf("station-instance-removing", "this station's stk instance is being removed")
	}

	var r record
	if !create {
		recs, err := m.readRecords()
		if err != nil {
			return nil, isolationInfo{}, err
		}
		var ok bool
		if r, ok = recs[station]; !ok {
			return nil, isolationInfo{}, nil
		}
		iso = m.isolationOf(recs, station, r.AgentUIDs)
	} else {
		err := m.updateRecords(func(recs map[string]record) (bool, error) {
			// Judged on where the agents REALLY run, not on what the operator mapped (see
			// effectiveUIDs).
			uids := m.effectiveUIDs(station, recs[station].StationKey)
			iso = m.isolationOf(recs, station, uids)
			if iso.Shared && !m.cfg.AllowSharedAgentUID {
				return false, codedf("station-uid-shared", "%s", sharedUIDMessage)
			}
			var ok bool
			if r, ok = recs[station]; ok {
				if sameUIDs(r.AgentUIDs, uids) {
					return false, nil
				}
				r.AgentUIDs = append([]int(nil), uids...)
				recs[station] = r
				return true, nil
			}
			// Reserve nothing for an instance this node cannot create: a non-root node asked
			// about many stations must not use up the port range.
			if m.env.goos != "linux" || m.env.euid != 0 {
				return false, coded("station-instance-unavailable", fmt.Errorf("%w (this node: %s, uid %d)", ErrInstanceUnavailable, m.env.goos, m.env.euid))
			}
			nr, err := m.allocate(recs, station, uids)
			if err != nil {
				return false, err
			}
			r = nr
			recs[station] = r
			return true, nil
		})
		if err != nil {
			return nil, isolationInfo{}, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if iso.Shared && !m.warned[station] {
		m.warned[station] = true
		logf("forgeapi: WARNING: station %s shares an agent uid with another station; per-station isolation does NOT hold (acknowledged by the operator)", station)
	}
	if cached := m.states[station]; cached != nil {
		return cached, iso, nil
	}
	st = m.build(m.instanceFor(r))
	m.states[station] = st
	return st, iso, nil
}

func (m *StationInstances) build(inst Instance) *stationState {
	newClient := func() stkclient.Client { return m.cfg.NewClient(inst) }
	opts := SetupOptions{
		ServiceUser: inst.User(), StateDir: inst.StateDir, RuntimeDir: inst.RuntimeDir,
		ConfigPath: inst.ConfigPath, ProxyPort: inst.Port, UnitName: inst.Unit(),
		AfterInstall: func(ctx context.Context) error {
			m.seedPolicy(inst)
			return m.cfg.Lifecycle.EnableNow(ctx, inst.Unit())
		},
	}
	env := m.env
	env.harnessUIDs = func() []int { return m.cfg.AgentUIDs(inst.Station) }
	opts.EffectiveUIDs = func() []int { return m.effectiveUIDs(inst.Station, m.keyOf(inst.Station)) }
	ens := &Ensurer{run: func(ctx context.Context) (SetupResult, error) {
		if env.goos != "linux" || env.euid != 0 {
			return SetupResult{}, fmt.Errorf("%w (this node: %s, uid %d)", ErrInstanceUnavailable, env.goos, env.euid)
		}
		o := opts
		// Until the instance's user exists, a client is not bound to it and its doctor describes
		// some other store.
		o.ForceInstall = !m.cfg.userExists(inst.User())
		return ensureF(ctx, newClient, o, env)
	},
		// A verdict is true of these uids and of the broker as doctor sees it now.
		fingerprint: func() string {
			return fmt.Sprint(m.cfg.AgentUIDs(inst.Station), m.effectiveUIDs(inst.Station, m.keyOf(inst.Station)))
		},
		recheck: func(ctx context.Context) bool {
			rep, err := newClient().Doctor(ctx)
			return err == nil && rep.Isolation.Level == LevelSeparateUser
		},
		now: m.clockNow,
	}
	st := &stationState{inst: inst}
	st.svc = &Service{
		Ensure: ens.Ensure, NewClient: newClient, PolicyPath: inst.ConfigPath,
		SharedPolicyPath: m.cfg.SharedPolicyPath, Station: inst.Station,
		Unwire: m.cfg.Unwire, Bypass: m.bypassHook(inst.Station, func() *stationState { return st }),
	}
	return st
}

// seedPolicy copies the shared base policy into a new instance's policy file before its unit
// starts. A problem is logged, not fatal: the instance works without it, and the next policy
// write reports the shared file's error to the hub.
func (m *StationInstances) seedPolicy(inst Instance) {
	warn := func(format string, a ...any) {
		msg := fmt.Sprintf(format, a...)
		logf("forgeapi: %s", msg)
		m.mu.Lock()
		m.seedWarn[inst.Station] = "the shared base policy was not copied into this station's policy: " + msg
		m.mu.Unlock()
	}
	m.mu.Lock()
	delete(m.seedWarn, inst.Station)
	m.mu.Unlock()
	shared, _, err := stkpolicy.ReadPolicyFile(m.cfg.SharedPolicyPath)
	if err != nil {
		warn("shared base policy unreadable: %v", clean(err.Error()))
		return
	}
	prev, _, err := stkpolicy.ReadPolicyFile(inst.ConfigPath)
	if err != nil {
		warn("policy of %s unreadable: %v", inst.Name, clean(err.Error()))
		return
	}
	out, skipped, err := stkpolicy.ApplyShared(prev, shared, inst.Station)
	if err != nil {
		warn("shared base policy not usable: %v", clean(err.Error()))
		return
	}
	for _, s := range skipped {
		logf("forgeapi: shared base policy entry skipped for %s: %s", inst.Name, s)
	}
	if string(out) == string(prev) {
		return
	}
	if err := stkpolicy.WritePolicyFile(inst.ConfigPath, out); err != nil {
		warn("shared base policy not written into %s: %v", inst.Name, clean(err.Error()))
	}
}
