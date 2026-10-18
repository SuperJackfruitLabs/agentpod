package forgeapi

// One stk instance per station (operator ruling 2026-10-18).
//
// Every station gets its own stk: its own OS user, state directory, runtime directory, policy
// file, proxy port, proxy key and systemd unit. A station's harness is given only its own
// instance's proxy URL and key, so one station's agent cannot use another station's brokered
// credential, and a revoke or prune for one station cannot touch another's.
//
// StationInstances is the node's table of those instances. It routes every forge.api frame by
// its stationId to that station's Service (service.go, one per instance), creates the instance
// lazily at the first deliver or status for a station, and removes it when the station is no
// longer hosted. Creating an instance needs root on Linux with systemd; without that, deliver and
// status answer `station-instance-unavailable` rather than fall back to a shared broker.
//
// Naming: every name derives from the station id and is recorded in a node-owned registry file
// (0600), together with the proxy port, so a restart finds the same instance. The registry is
// also the node's managed marker: removal only ever touches instances listed in it.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

// Defaults for InstancesConfig.
const (
	DefaultRegistryPath     = "/var/lib/agentpod/forge-api/stk-instances.json"
	DefaultSharedPolicyPath = "/etc/agentpod/stk-shared.yaml"
	DefaultPortMin          = 8900
	DefaultPortMax          = 8999
	DefaultStateRoot        = "/var/lib"
	DefaultConfigRoot       = "/etc"
	DefaultRuntimeRoot      = "/run" // stk wants the runtime dir directly under /run

	registryVersion = 1
	registryMarker  = "agentpod-node"
	maxStationID    = 128
	maxSlug         = 12
	minHex, maxHex  = 6, 14 // 4+12+1+14 = 31, inside useradd's 32-character limit
)

// ErrInstanceUnavailable: this node cannot create or reach a per-station stk instance.
var ErrInstanceUnavailable = errors.New("per-station stk instances need a Linux node running as root with systemd")

// instanceNameRE is the only shape of name the node will ever act on (create, or remove).
var instanceNameRE = regexp.MustCompile(`^stk-[a-z0-9-]{1,12}-[0-9a-f]{6,14}$`)

// Instance is one station's stk. Paths are derived from the roots, not stored.
type Instance struct {
	Station    string
	Name       string // also the OS user, the group and the systemd unit
	Port       int
	StateDir   string
	RuntimeDir string
	ConfigPath string
}

// User is the OS user (and group) the instance runs as.
func (i Instance) User() string { return i.Name }

// Unit is the systemd unit, without ".service".
func (i Instance) Unit() string { return i.Name }

// SocketPath is the instance's stk socket (what STK_SOCKET names).
func (i Instance) SocketPath() string { return filepath.Join(i.RuntimeDir, "stk.sock") }

// Lifecycle is everything the node does to the host to create or remove an instance beyond
// `stk install`. Every method is idempotent and tolerates what is already gone. A fake stands in
// for it in tests; SystemLifecycle is the real one.
type Lifecycle interface {
	EnableNow(ctx context.Context, unit string) error
	StopDisable(ctx context.Context, unit string) error
	RemoveUnit(ctx context.Context, unit string) error
	RemoveUser(ctx context.Context, user string) error
	RemoveTree(ctx context.Context, path string) error
}

// InstancesConfig configures StationInstances. Zero values mean the defaults above.
type InstancesConfig struct {
	RegistryPath     string
	SharedPolicyPath string
	PortMin, PortMax int
	// Roots the per-instance paths are made under: <StateRoot>/<name>, <ConfigRoot>/<name>/
	// supertoolkit.yaml, <RuntimeRoot>/<name>.
	StateRoot, ConfigRoot, RuntimeRoot string

	// NewClient builds an stk client bound to one instance (RunAs its user, STK_HOME/STK_CONFIG/
	// STK_SOCKET of the instance), reflecting the machine as it is now. Required.
	NewClient func(Instance) stkclient.Client
	// Lifecycle starts and removes units and users. Required.
	Lifecycle Lifecycle
	// AgentUIDs is who may use a station's broker; default: the uid the node spawns harnesses as.
	AgentUIDs func(station string) []int
	// Unwire removes the harness wiring for a grant (Task 5); Bypass is the bypass check (Task 6).
	Unwire func(grantID string) error
	Bypass func(ctx context.Context, c stkclient.Client) any

	// test seams
	env        *sysEnv
	userExists func(string) bool
	portFree   func(int) bool
}

// StationInstances answers the forge.api verbs for every station on the node.
type StationInstances struct {
	cfg InstancesConfig
	env sysEnv

	mu       sync.Mutex
	loaded   bool
	records  map[string]record // by station id
	states   map[string]*stationState
	removing map[string]bool
}

type stationState struct {
	inst Instance
	svc  *Service
}

// record is what the registry file keeps per instance. No secret, ever.
type record struct {
	Station string `json:"station"`
	Name    string `json:"name"`
	Port    int    `json:"port"`
}

type registryFile struct {
	Version   int      `json:"version"`
	ManagedBy string   `json:"managedBy"`
	Instances []record `json:"instances"`
}

// NewStationInstances returns the manager. Nothing is read or run until the first frame.
func NewStationInstances(cfg InstancesConfig) (*StationInstances, error) {
	if cfg.NewClient == nil || cfg.Lifecycle == nil {
		return nil, errors.New("forgeapi: StationInstances needs NewClient and Lifecycle")
	}
	d := func(v *string, def string) {
		if *v == "" {
			*v = def
		}
	}
	d(&cfg.RegistryPath, DefaultRegistryPath)
	d(&cfg.SharedPolicyPath, DefaultSharedPolicyPath)
	d(&cfg.StateRoot, DefaultStateRoot)
	d(&cfg.ConfigRoot, DefaultConfigRoot)
	d(&cfg.RuntimeRoot, DefaultRuntimeRoot)
	if cfg.PortMin == 0 && cfg.PortMax == 0 {
		cfg.PortMin, cfg.PortMax = DefaultPortMin, DefaultPortMax
	}
	if cfg.PortMin < 1 || cfg.PortMax > 65535 || cfg.PortMin > cfg.PortMax {
		return nil, fmt.Errorf("forgeapi: invalid stk proxy port range %d-%d", cfg.PortMin, cfg.PortMax)
	}
	if cfg.AgentUIDs == nil {
		cfg.AgentUIDs = func(string) []int { return NodeHarnessUIDs() }
	}
	if cfg.userExists == nil {
		cfg.userExists = osUserExists
	}
	if cfg.portFree == nil {
		cfg.portFree = tcpPortFree
	}
	m := &StationInstances{cfg: cfg, env: hostEnv(), states: map[string]*stationState{}, removing: map[string]bool{}}
	if cfg.env != nil {
		m.env = *cfg.env
	}
	return m, nil
}

func osUserExists(name string) bool { _, err := user.Lookup(name); return err == nil }

func tcpPortFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// ---- naming ----

func slugOf(station string) string {
	var b strings.Builder
	dash := true // no leading dash
	for _, r := range strings.ToLower(station) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	s := b.String()
	if len(s) > maxSlug {
		s = s[:maxSlug]
	}
	s = strings.TrimRight(s, "-")
	if s == "" {
		s = "st"
	}
	return s
}

// instanceName is stk-<slug>-<hex of sha256(station)>, with hexLen hex characters.
func instanceName(station string, hexLen int) string {
	sum := sha256.Sum256([]byte(station))
	return "stk-" + slugOf(station) + "-" + hex.EncodeToString(sum[:])[:hexLen]
}

func checkStationID(id string) error {
	if strings.TrimSpace(id) == "" {
		return codedf("invalid-params", "stationId is required")
	}
	if len(id) > maxStationID {
		return codedf("invalid-params", "stationId is longer than %d bytes", maxStationID)
	}
	for _, r := range id {
		if r < 0x20 || (r >= 0x7f && r <= 0x9f) {
			return codedf("invalid-params", "stationId contains a control character")
		}
	}
	return nil
}

func (m *StationInstances) instanceFor(r record) Instance {
	return Instance{
		Station: r.Station, Name: r.Name, Port: r.Port,
		StateDir:   filepath.Join(m.cfg.StateRoot, r.Name),
		RuntimeDir: filepath.Join(m.cfg.RuntimeRoot, r.Name),
		ConfigPath: filepath.Join(m.cfg.ConfigRoot, r.Name, "supertoolkit.yaml"),
	}
}

// ---- registry ----

func (m *StationInstances) loadLocked() error {
	if m.loaded {
		return nil
	}
	data, _, err := readPolicyFile(m.cfg.RegistryPath)
	if err != nil {
		return coded("registry-unreadable", err)
	}
	recs := map[string]record{}
	if len(strings.TrimSpace(string(data))) > 0 {
		var f registryFile
		if err := json.Unmarshal(data, &f); err != nil {
			return coded("registry-invalid", fmt.Errorf("%s is not valid JSON; fix or remove it by hand: %v", m.cfg.RegistryPath, err))
		}
		if f.Version != registryVersion || f.ManagedBy != registryMarker {
			return codedf("registry-invalid", "%s is not this node's registry (version %d, managedBy %q)", m.cfg.RegistryPath, f.Version, f.ManagedBy)
		}
		names, ports := map[string]bool{}, map[int]bool{}
		for _, r := range f.Instances {
			if r.Station == "" || !instanceNameRE.MatchString(r.Name) || r.Port < 1 || r.Port > 65535 || names[r.Name] || ports[r.Port] || recs[r.Station].Name != "" {
				return codedf("registry-invalid", "%s holds an entry the node did not write; fix or remove it by hand", m.cfg.RegistryPath)
			}
			names[r.Name], ports[r.Port] = true, true
			recs[r.Station] = r
		}
	}
	m.records, m.loaded = recs, true
	return nil
}

func (m *StationInstances) saveLocked() error {
	f := registryFile{Version: registryVersion, ManagedBy: registryMarker, Instances: []record{}}
	for _, r := range m.records {
		f.Instances = append(f.Instances, r)
	}
	sort.Slice(f.Instances, func(i, j int) bool { return f.Instances[i].Port < f.Instances[j].Port })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(m.cfg.RegistryPath, append(b, '\n'), 0o600)
}

// writeFileAtomic replaces path via a temporary file in the same directory, fsynced and renamed.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".registry-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	fail := func(err error) error { _ = tmp.Close(); _ = os.Remove(name); return err }
	if _, err := tmp.Write(data); err != nil {
		return fail(err)
	}
	if err := tmp.Chmod(mode); err != nil {
		return fail(err)
	}
	if err := tmp.Sync(); err != nil {
		return fail(err)
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := os.Rename(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}

// allocateLocked picks the station's name and port and records them. A name another station
// already holds (a hash prefix collision) is lengthened until it is free.
func (m *StationInstances) allocateLocked(station string) (record, error) {
	taken := map[string]bool{}
	usedPorts := map[int]bool{}
	for _, r := range m.records {
		taken[r.Name] = true
		usedPorts[r.Port] = true
	}
	name := ""
	for n := minHex; n <= maxHex; n += 2 {
		if c := instanceName(station, n); !taken[c] {
			name = c
			break
		}
	}
	if name == "" {
		return record{}, codedf("instance-name-collision", "no free instance name for this station id")
	}
	for p := m.cfg.PortMin; p <= m.cfg.PortMax; p++ {
		if usedPorts[p] || !m.cfg.portFree(p) {
			continue
		}
		r := record{Station: station, Name: name, Port: p}
		m.records[station] = r
		if err := m.saveLocked(); err != nil {
			delete(m.records, station)
			return record{}, coded("registry-write-failed", err)
		}
		return r, nil
	}
	return record{}, codedf("port-range-exhausted", "no free stk proxy port between %d and %d for this station; widen the range or remove stations that are gone", m.cfg.PortMin, m.cfg.PortMax)
}

// ---- per-station state ----

// lookup returns the station's state, creating its record (not the instance on the host) when
// create is set. A station with no record and create unset is (nil, nil).
func (m *StationInstances) lookup(station string, create bool) (*stationState, error) {
	if err := checkStationID(station); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.loadLocked(); err != nil {
		return nil, err
	}
	if m.removing[station] {
		return nil, codedf("station-instance-removing", "this station's stk instance is being removed")
	}
	if st := m.states[station]; st != nil {
		return st, nil
	}
	r, ok := m.records[station]
	if !ok {
		if !create {
			return nil, nil
		}
		// Reserve nothing for an instance this node cannot create: a non-root node asked about
		// many stations must not use up the port range.
		if m.env.goos != "linux" || m.env.euid != 0 {
			return nil, coded("station-instance-unavailable", fmt.Errorf("%w (this node: %s, uid %d)", ErrInstanceUnavailable, m.env.goos, m.env.euid))
		}
		var err error
		if r, err = m.allocateLocked(station); err != nil {
			return nil, err
		}
	}
	st := m.build(m.instanceFor(r))
	m.states[station] = st
	return st, nil
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
	ens := &Ensurer{run: func(ctx context.Context) (SetupResult, error) {
		if env.goos != "linux" || env.euid != 0 {
			return SetupResult{}, fmt.Errorf("%w (this node: %s, uid %d)", ErrInstanceUnavailable, env.goos, env.euid)
		}
		o := opts
		// Until the instance's user exists, a client is not bound to it and its doctor describes
		// some other store.
		o.ForceInstall = !m.cfg.userExists(inst.User())
		return ensureF(ctx, newClient, o, env)
	}}
	return &stationState{inst: inst, svc: &Service{
		Ensure: ens.Ensure, NewClient: newClient, PolicyPath: inst.ConfigPath,
		SharedPolicyPath: m.cfg.SharedPolicyPath, Station: inst.Station,
		Unwire: m.cfg.Unwire, Bypass: m.cfg.Bypass,
	}}
}

// seedPolicy copies the shared base policy into a new instance's policy file before its unit
// starts. A problem is logged, not fatal: the instance works without it, and the next policy
// write reports the shared file's error to the hub.
func (m *StationInstances) seedPolicy(inst Instance) {
	shared, _, err := readPolicyFile(m.cfg.SharedPolicyPath)
	if err != nil {
		logf("forgeapi: shared base policy unreadable, not seeded into %s: %v", inst.Name, clean(err.Error()))
		return
	}
	prev, _, err := readPolicyFile(inst.ConfigPath)
	if err != nil {
		logf("forgeapi: policy of %s unreadable, shared base policy not seeded: %v", inst.Name, clean(err.Error()))
		return
	}
	out, skipped, err := ApplyShared(prev, shared, inst.Station)
	if err != nil {
		logf("forgeapi: shared base policy not seeded into %s: %v", inst.Name, clean(err.Error()))
		return
	}
	for _, s := range skipped {
		logf("forgeapi: shared base policy entry skipped for %s: %s", inst.Name, s)
	}
	if string(out) == string(prev) {
		return
	}
	if err := writePolicyFile(inst.ConfigPath, out); err != nil {
		logf("forgeapi: shared base policy not written into %s: %v", inst.Name, clean(err.Error()))
	}
}

// Instance returns a station's instance if the node has one on record.
func (m *StationInstances) Instance(station string) (Instance, bool) {
	st, err := m.lookup(station, false)
	if err != nil || st == nil {
		return Instance{}, false
	}
	return st.inst, true
}

// Ensure creates the station's instance now (the CLI's `forge-api setup --station`).
func (m *StationInstances) Ensure(ctx context.Context, station string) (SetupResult, Instance, error) {
	st, err := m.lookup(station, true)
	if err != nil {
		return SetupResult{}, Instance{}, err
	}
	res, err := st.svc.Ensure(ctx)
	return res, st.inst, err
}

// ---- the verbs, routed by station ----

func (m *StationInstances) Deliver(ctx context.Context, p DeliverParams) (DeliverAck, error) {
	// A bad frame must not cost an instance.
	if _, err := validateDeliver(p); err != nil {
		return DeliverAck{}, err
	}
	st, err := m.lookup(p.StationID, true)
	if err != nil {
		return DeliverAck{}, err
	}
	return st.svc.Deliver(ctx, p)
}

func (m *StationInstances) Policy(ctx context.Context, p PolicyParams) (PolicyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return PolicyAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	st, err := m.lookup(p.StationID, false)
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
	st, err := m.lookup(p.StationID, false)
	if err != nil {
		return VerifyAck{}, err
	}
	if st == nil {
		return VerifyAck{}, codedf("unknown-grant", "this node holds no entry for grant %s", p.GrantID)
	}
	return st.svc.Verify(ctx, p)
}

func (m *StationInstances) Revoke(ctx context.Context, p RevokeParams) (RevokeAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return RevokeAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
	st, err := m.lookup(p.StationID, false)
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
	return st.svc.Revoke(ctx, p)
}

// Status creates the station's instance if there is none: the hub fetches the station's public
// key through status before the first grant, and the key belongs to the instance's own store.
// On a node that cannot create it, status fails with `station-instance-unavailable`.
func (m *StationInstances) Status(ctx context.Context, p StatusParams) (StatusAck, error) {
	st, err := m.lookup(p.StationID, true)
	if err != nil {
		return StatusAck{}, err
	}
	return st.svc.Status(ctx, p)
}

// ---- removal ----

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
	m.mu.Lock()
	if err := m.loadLocked(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	var stale []record
	for st, r := range m.records {
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
	if m.cfg.Unwire != nil {
		data, _, err := readPolicyFile(inst.ConfigPath)
		if err != nil {
			return coded("policy-read-failed", err)
		}
		entries, err := ManagedEntries(data)
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
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.records, r.Station)
	delete(m.states, r.Station)
	if err := m.saveLocked(); err != nil {
		m.records[r.Station] = r // the host is clean; keep the record so a retry rewrites the file
		return coded("registry-write-failed", err)
	}
	logf("forgeapi: removed the stk instance of station %s", r.Station)
	return nil
}
