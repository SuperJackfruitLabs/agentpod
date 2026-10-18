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
	// AgentUIDs is the uid(s) a station's agents run as, which is who may use that station's
	// broker. Default: the uid the node spawns harnesses as, the same for every station, so a
	// second station is refused (station-uid-shared) unless AllowSharedAgentUID is set.
	AgentUIDs func(station string) []int
	// AllowSharedAgentUID is the operator's explicit acknowledgement that stations whose agents
	// share a uid are not isolated from each other. Default false (fail closed).
	AllowSharedAgentUID bool
	// Unwire removes the harness wiring for a grant (Task 5); Bypass is the bypass check (Task 6).
	Unwire        func(grantID string) error
	Bypass        func(ctx context.Context, c stkclient.Client) []ClientOutcome
	HarnessProbes map[string][]string
	ProbeExec     func(ctx context.Context, argv, env []string) (string, error)
	// Harness, when set, routes each station's harness through its own instance: the node records
	// the station's key at deliver, hands spawns the instance's proxy environment (EnvForKey) and
	// writes drop-in environment files for systemd-started harnesses. Nil: no harness wiring.
	Harness *HarnessWiring

	// test seams
	env        *sysEnv
	userExists func(string) bool
	portFree   func(int) bool
}

// StationInstances answers the forge.api verbs for every station on the node.
type StationInstances struct {
	cfg InstancesConfig
	env sysEnv

	// mu guards states, removing and warned. The registry file is not cached: it is read afresh
	// (and written only under an flock on <registry>.lock) because `apn forge-api setup
	// --station` writes it from another process.
	mu       sync.Mutex
	states   map[string]*stationState
	removing map[string]bool
	warned   map[string]bool
	seedWarn map[string]string // station -> why the shared base policy was not seeded

	wiringMu   sync.Mutex                   // serialises harness wiring (env files and drop-ins)
	blocked    map[string]map[string]string // station -> source ("spawn", "unit") -> why wiring is blocked; guarded by mu
	refreshMu  sync.Mutex                   // serialises shared-policy refreshes
	sharedHash string
	sharedSeen bool
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
	// AgentUIDs are the uids the station's agents ran as when the instance was last used; the
	// next station's uids are compared with them.
	AgentUIDs []int `json:"agentUids,omitempty"`
	// StationKey is the node's key for the station's harness ("hermes:press"), recorded at deliver
	// so a spawn, which knows only the key, finds the station's instance. Not a secret.
	StationKey string `json:"stationKey,omitempty"`
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
	m := &StationInstances{cfg: cfg, env: hostEnv(), states: map[string]*stationState{}, removing: map[string]bool{}, warned: map[string]bool{}, seedWarn: map[string]string{}}
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

// readRecords reads and validates the registry as it is on disk right now.
func (m *StationInstances) readRecords() (map[string]record, error) {
	data, _, err := readPolicyFile(m.cfg.RegistryPath)
	if err != nil {
		return nil, coded("registry-unreadable", err)
	}
	recs := map[string]record{}
	if len(strings.TrimSpace(string(data))) > 0 {
		var f registryFile
		if err := json.Unmarshal(data, &f); err != nil {
			return nil, coded("registry-invalid", fmt.Errorf("%s is not valid JSON; fix or remove it by hand: %v", m.cfg.RegistryPath, err))
		}
		if f.Version != registryVersion || f.ManagedBy != registryMarker {
			return nil, codedf("registry-invalid", "%s is not this node's registry (version %d, managedBy %q)", m.cfg.RegistryPath, f.Version, f.ManagedBy)
		}
		names, ports := map[string]bool{}, map[int]bool{}
		for _, r := range f.Instances {
			if r.Station == "" || !instanceNameRE.MatchString(r.Name) || r.Port < 1 || r.Port > 65535 || names[r.Name] || ports[r.Port] || recs[r.Station].Name != "" || !validUIDs(r.AgentUIDs) {
				return nil, codedf("registry-invalid", "%s holds an entry the node did not write; fix or remove it by hand", m.cfg.RegistryPath)
			}
			names[r.Name], ports[r.Port] = true, true
			recs[r.Station] = r
		}
	}
	return recs, nil
}

func validUIDs(uids []int) bool {
	for _, u := range uids {
		if u < 0 || int64(u) > maxUID {
			return false
		}
	}
	return true
}

// writeRecords replaces the registry file. The caller holds the registry lock.
func (m *StationInstances) writeRecords(recs map[string]record) error {
	f := registryFile{Version: registryVersion, ManagedBy: registryMarker, Instances: []record{}}
	for _, r := range recs {
		f.Instances = append(f.Instances, r)
	}
	sort.Slice(f.Instances, func(i, j int) bool { return f.Instances[i].Port < f.Instances[j].Port })
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(m.cfg.RegistryPath, append(b, '\n'), 0o600)
}

// updateRecords runs fn on the registry as it is on disk under the registry lock and writes it
// back when fn says it changed it. Every change to the registry goes through here, so a record
// another process wrote a moment ago is never lost to a stale copy.
func (m *StationInstances) updateRecords(fn func(recs map[string]record) (changed bool, err error)) error {
	unlock, err := lockRegistry(m.cfg.RegistryPath)
	if err != nil {
		return coded("registry-lock-failed", err)
	}
	defer unlock()
	recs, err := m.readRecords()
	if err != nil {
		return err
	}
	changed, err := fn(recs)
	if err != nil || !changed {
		return err
	}
	if err := m.writeRecords(recs); err != nil {
		return coded("registry-write-failed", err)
	}
	return nil
}

func sameUIDs(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	x := append([]int(nil), a...)
	y := append([]int(nil), b...)
	sort.Ints(x)
	sort.Ints(y)
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// sharesUID reports whether the station's uids overlap those of any OTHER registered instance.
func sharesUID(recs map[string]record, station string, uids []int) bool {
	for st, r := range recs {
		if st == station {
			continue
		}
		for _, u := range uids {
			for _, v := range r.AgentUIDs {
				if u == v {
					return true
				}
			}
		}
	}
	return false
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

// allocate picks the station's name and port in recs (the registry as just read under the lock).
// A name another station already holds (a hash prefix collision) is lengthened until it is free.
func (m *StationInstances) allocate(recs map[string]record, station string, uids []int) (record, error) {
	taken := map[string]bool{}
	usedPorts := map[int]bool{}
	for _, r := range recs {
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
		return record{Station: station, Name: name, Port: p, AgentUIDs: append([]int(nil), uids...)}, nil
	}
	return record{}, codedf("port-range-exhausted", "no free stk proxy port between %d and %d for this station; widen the range or remove stations that are gone", m.cfg.PortMin, m.cfg.PortMax)
}

const sharedUIDMessage = "stations on this node share an agent uid, so per-station isolation cannot hold; give each station's agents their own uid through the node's per-station uid mapping (forgeApi.stationUids), or acknowledge the risk with allowSharedAgentUid"

// ---- per-station state ----

// lookup returns the station's state. With create it registers the station (name, port, uids; no
// instance on the host yet) under the registry lock, refusing `station-uid-shared` when its agents
// share a uid with another registered station and the operator has not acknowledged that. shared
// reports an acknowledged overlap. A station with no record and create unset is (nil, false, nil).
func (m *StationInstances) lookup(station string, create bool) (st *stationState, shared bool, err error) {
	if err := checkStationID(station); err != nil {
		return nil, false, err
	}
	m.mu.Lock()
	removing := m.removing[station]
	m.mu.Unlock()
	if removing {
		return nil, false, codedf("station-instance-removing", "this station's stk instance is being removed")
	}

	var r record
	if !create {
		recs, err := m.readRecords()
		if err != nil {
			return nil, false, err
		}
		var ok bool
		if r, ok = recs[station]; !ok {
			return nil, false, nil
		}
		shared = sharesUID(recs, station, r.AgentUIDs)
	} else {
		uids := m.cfg.AgentUIDs(station)
		err := m.updateRecords(func(recs map[string]record) (bool, error) {
			shared = sharesUID(recs, station, uids)
			if shared && !m.cfg.AllowSharedAgentUID {
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
			return nil, false, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if shared && !m.warned[station] {
		m.warned[station] = true
		logf("forgeapi: WARNING: station %s shares an agent uid with another station; per-station isolation does NOT hold (acknowledged by the operator)", station)
	}
	if cached := m.states[station]; cached != nil {
		return cached, shared, nil
	}
	st = m.build(m.instanceFor(r))
	m.states[station] = st
	return st, shared, nil
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
	shared, _, err := readPolicyFile(m.cfg.SharedPolicyPath)
	if err != nil {
		warn("shared base policy unreadable: %v", clean(err.Error()))
		return
	}
	prev, _, err := readPolicyFile(inst.ConfigPath)
	if err != nil {
		warn("policy of %s unreadable: %v", inst.Name, clean(err.Error()))
		return
	}
	out, skipped, err := ApplyShared(prev, shared, inst.Station)
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
	if err := writePolicyFile(inst.ConfigPath, out); err != nil {
		warn("shared base policy not written into %s: %v", inst.Name, clean(err.Error()))
	}
}

// Instance returns a station's instance if the node has one on record.
func (m *StationInstances) Instance(station string) (Instance, bool) {
	st, _, err := m.lookup(station, false)
	if err != nil || st == nil {
		return Instance{}, false
	}
	return st.inst, true
}

// Ensure creates the station's instance now (the CLI's `forge-api setup --station`).
func (m *StationInstances) Ensure(ctx context.Context, station string) (SetupResult, Instance, error) {
	st, _, err := m.lookup(station, true)
	if err != nil {
		return SetupResult{}, Instance{}, err
	}
	res, err := st.svc.Ensure(ctx)
	return res, st.inst, err
}

// IsolationSharedUID is the detail an acknowledged shared-uid station reports beside the contract's
// `same-user`: the contract's isolation enum has only separate-user and same-user, and a word the
// hub's schema does not know would make the whole reply unreadable.
const IsolationSharedUID = "shared-uid"

// ---- the verbs, routed by station ----

func (m *StationInstances) Deliver(ctx context.Context, p DeliverParams) (DeliverAck, error) {
	// A bad frame must not cost an instance.
	if _, err := validateDeliver(p); err != nil {
		return DeliverAck{}, err
	}
	m.maybeRefreshShared(ctx)
	// A key that already belongs to another station is refused before an instance is created.
	if err := m.checkKeyFree(p.StationID, p.StationKey); err != nil {
		return DeliverAck{}, err
	}
	st, shared, err := m.lookup(p.StationID, true)
	if err != nil {
		return DeliverAck{}, err
	}
	ack, err := st.svc.Deliver(ctx, p)
	if err != nil {
		return ack, err
	}
	if shared {
		ack.Isolation, ack.IsolationDetail, ack.Reason = "same-user", IsolationSharedUID, sharedUIDMessage
	}
	// The harness is wired only once stk holds the credential. A failure here is the deliver's
	// failure: the grant would otherwise look usable while the agent has no route to it.
	res, werr := m.wireStation(ctx, st, p.StationKey)
	if werr != nil {
		return DeliverAck{}, werr
	}
	ack.NeedsRestart, ack.Wired = res.restart, res.wired
	return ack, nil
}

func (m *StationInstances) Policy(ctx context.Context, p PolicyParams) (PolicyAck, error) {
	if strings.TrimSpace(p.StationID) == "" || strings.TrimSpace(p.GrantID) == "" {
		return PolicyAck{}, codedf("invalid-params", "stationId and grantId are required")
	}
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
	st, shared, err := m.lookup(p.StationID, false)
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
	if shared {
		ack.Isolation, ack.IsolationDetail = "same-user", IsolationSharedUID
	}
	// What the node wired, beside what was measured: the ack never implies brokered coverage the
	// node did not set up.
	if ack.Bypass == nil {
		ack.Bypass = &BypassReport{}
	}
	harness, paths, blocked := m.coverage(p.StationID)
	ack.Bypass.Harness, ack.Bypass.Paths, ack.Bypass.WiringBlocked = harness, paths, blocked
	ack.Bypass.Brokered = blocked == "" && len(paths) > 0
	for _, pa := range paths {
		ack.Bypass.Brokered = ack.Bypass.Brokered && pa.Wired
	}
	ack.applyCoverage()
	return ack, nil
}

func (m *StationInstances) Revoke(ctx context.Context, p RevokeParams) (RevokeAck, error) {
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
	m.maybeRefreshShared(ctx)
	st, shared, err := m.lookup(p.StationID, true)
	if err != nil {
		return StatusAck{}, err
	}
	ack, err := st.svc.Status(ctx, p)
	if err != nil {
		return ack, err
	}
	if shared {
		for i := range ack.Grants {
			ack.Grants[i].Isolation, ack.Grants[i].IsolationDetail = "same-user", IsolationSharedUID
		}
		ack.Warnings = append(ack.Warnings, sharedUIDMessage)
	}
	m.mu.Lock()
	if w := m.seedWarn[p.StationID]; w != "" {
		ack.Warnings = append(ack.Warnings, w)
	}
	m.mu.Unlock()
	return ack, nil
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

// ---- shared base policy refresh ----

// sharedFingerprint is a cheap change detector for the shared base policy file ("" when absent).
func (m *StationInstances) sharedFingerprint() (string, error) {
	b, existed, err := readPolicyFile(m.cfg.SharedPolicyPath)
	if err != nil {
		return "", err
	}
	if !existed {
		return "absent", nil
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

// maybeRefreshShared refreshes every registered instance when the shared base policy differs from
// the one last applied (and once at the node's first frame, when nothing has been applied yet).
// Called before deliver, policy and status for ANY station, so a service the operator removed is
// gone from every station's policy, credential forgotten first, without waiting for that
// station's own next write. Problems are logged; the fingerprint is kept only after a clean pass,
// so a failure is retried on the next frame.
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
	if m.sharedSeen && fp == m.sharedHash {
		return
	}
	if err := m.refreshAllShared(ctx); err != nil {
		logf("forgeapi: shared base policy not refreshed everywhere: %v", clean(err.Error()))
		return
	}
	m.sharedHash, m.sharedSeen = fp, true
}

// RefreshShared refreshes every registered instance now (the node calls it once at start).
func (m *StationInstances) RefreshShared(ctx context.Context) {
	m.maybeRefreshShared(ctx)
}

func (m *StationInstances) refreshAllShared(ctx context.Context) error {
	recs, err := m.readRecords()
	if err != nil {
		return err
	}
	var errs []error
	for station, r := range recs {
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
		if err := st.svc.RefreshShared(ctx); err != nil {
			errs = append(errs, fmt.Errorf("station %s: %w", station, err))
		}
	}
	return errors.Join(errs...)
}
