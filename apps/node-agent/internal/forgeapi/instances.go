package forgeapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

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
	// HarnessRunsAs says which uid a path of a station's harness really runs as: "spawn" (ACP
	// sessions and terminals the node starts) or "gateway" (a long-lived unit of the station's
	// own). known is false when the node cannot tell, and an unknown path counts as running at
	// the NODE's uid. The node spawns with plain exec and no uid switch, so its own supply says
	// "spawn" runs as the node: an isolation verdict of separate-user is only possible when every
	// path the station has runs as a distinct non-node uid. Nil: nothing is known.
	HarnessRunsAs func(station, path string) (uid int, known bool)
	// Hosted says whether this node itself detects a station with this key (the descriptor
	// registry). A deliver for a key it does not detect, and a status for a station whose
	// recorded key it no longer detects, is refused `station-not-hosted` without creating
	// anything. Nil: not checked (tests, the CLI). The node cannot know a hub station id, only
	// keys, so a first status for a station that has no recorded key is the one case it cannot
	// bind.
	Hosted func(key string) bool
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
	onRefresh  func(station string) // a shared-policy refresh was attempted for the station
	now        func() time.Time
	geteuid    func() int
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

	wiringMu    sync.Mutex                   // serialises harness wiring (env files and drop-ins)
	blocked     map[string]map[string]string // station -> source ("spawn", "unit") -> why wiring is blocked; guarded by mu
	refreshMu   sync.Mutex                   // serialises shared-policy refreshes
	sharedFP    map[string]string            // station -> fingerprint of the shared file last applied to it
	sharedRetry map[string]time.Time         // station -> do not retry its failed refresh before
	probeMu     sync.Mutex
	probes      map[string]cachedProbe // station -> last clean bypass probe
}

// NewStationInstances returns the manager. Nothing is read or run until the first frame.
func NewStationInstances(cfg InstancesConfig) (*StationInstances, error) {
	if cfg.NewClient == nil || cfg.Lifecycle == nil {
		return nil, errors.New("forgeapi: StationInstances needs NewClient and Lifecycle")
	}
	if len(cfg.HarnessProbes) > 0 && cfg.ProbeExec == nil {
		geteuid := cfg.geteuid
		if geteuid == nil {
			geteuid = os.Geteuid
		}
		if geteuid() == 0 {
			return nil, errors.New("forgeapi: harness probes are refused on a root node: the command would run as root without a process-group kill")
		}
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

// ---- removal ----

// Stations lists the stations the registry holds an instance for.
func (m *StationInstances) Stations() ([]string, error) {
	recs, err := m.readRecords()
	if err != nil {
		return nil, err
	}
	var out []string
	for st := range recs {
		out = append(out, st)
	}
	sort.Strings(out)
	return out, nil
}
